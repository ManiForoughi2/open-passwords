const views = {
  nohelper: document.getElementById("view-nohelper"),
  pin: document.getElementById("view-pin"),
  connecting: document.getElementById("view-connecting"),
  unlocked: document.getElementById("view-unlocked"),
};
const dot = document.getElementById("dot");
const pinInput = document.getElementById("pin");
const pinError = document.getElementById("pin-error");
const refreshBtn = document.getElementById("refresh");

function show(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}

document.getElementById("chrome-guide").addEventListener("click", () => {
  const steps = document.getElementById("chrome-steps");
  steps.hidden = !steps.hidden;
});
document.getElementById("open-chrome-settings").addEventListener("click", () => {
  // chrome:// pages cant be opened via a link, need tabs.create. maps to brave:// in brave
  chrome.tabs.create({ url: "chrome://password-manager/settings" });
});

// togglable suppression of the browser's save/update bubble. ON sets the pref off, OFF hands
// control back to the browser. the choice persists and the background respects it on startup
const pmToggle = document.getElementById("pm-toggle");
const pmNote = document.getElementById("pm-note");

function renderPmToggle() {
  const pref = chrome.privacy?.services?.passwordSavingEnabled;
  const row = document.getElementById("pm-row");
  if (!pref?.get) return;
  pref.get({}, (d) => {
    if (chrome.runtime.lastError || !d) return;
    row.hidden = false;
    pmToggle.checked = d.value === false;
    const controllable =
      d.levelOfControl === "controllable_by_this_extension" ||
      d.levelOfControl === "controlled_by_this_extension";
    pmToggle.disabled = !controllable;
    pmNote.textContent = controllable
      ? ""
      : d.levelOfControl === "controlled_by_other_extensions"
        ? "controlled by another extension"
        : "controlled by browser policy";
  });
}

pmToggle.addEventListener("change", () => {
  const pref = chrome.privacy?.services?.passwordSavingEnabled;
  if (!pref) return;
  const on = pmToggle.checked;
  chrome.storage?.local?.set({ suppressSaveBubble: on });
  if (on) pref.set({ value: false }, () => renderPmToggle());
  else pref.clear({}, () => renderPmToggle());
});

renderPmToggle();

function setDot(state) {
  dot.className = "dot";
  if (state === "unlocked") dot.classList.add("ok");
  else if (state === "needs_pin") dot.classList.add("warn");
  else if (state === "no_helper") dot.classList.add("err");
}

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let lastState = "disconnected";

async function render(state) {
  lastState = state;
  setDot(state);
  refreshBtn.hidden = state !== "unlocked" && state !== "needs_pin";
  if (state === "no_helper") return show("nohelper");
  if (state === "disconnected") return show("connecting");
  if (state === "needs_pin") {
    show("pin");
    pinInput.focus();
    return;
  }
  if (state === "unlocked") {
    await renderLogins();
    return show("unlocked");
  }
  // unknown state must never leave every view hidden (blank popup)
  show("connecting");
}

async function renderLogins() {
  const tab = await activeTab();
  document.getElementById("site").textContent = tab?.url ? new URL(tab.url).hostname : "";
  const list = document.getElementById("logins");
  const none = document.getElementById("nologins");
  list.innerHTML = "";
  none.hidden = true;

  const res = await send({ type: "getLogins", tabId: tab.id, url: tab.url });
  if (!res?.ok) {
    none.hidden = false;
    none.textContent = res?.error ?? "Couldn't load logins.";
    return;
  }
  if (!res.logins.length) {
    none.hidden = false;
    return;
  }
  for (const login of res.logins) {
    const li = document.createElement("li");
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = login.username || "(no username)";
    const fill = document.createElement("button");
    fill.textContent = "Fill";
    fill.addEventListener("click", async () => {
      fill.disabled = true;
      const r = await send({ type: "fillOnPage", tabId: tab.id, url: tab.url, loginName: login });
      if (r?.ok && r.filled) window.close();
      else fill.disabled = false;
    });
    li.append(u, fill);
    list.appendChild(li);
  }
}

document.getElementById("verify").addEventListener("click", async () => {
  pinError.hidden = true;
  const pin = pinInput.value.trim();
  if (pin.length < 4) return;
  const res = await send({ type: "verifyPin", pin });
  if (res?.ok) render(res.state);
  else {
    pinError.textContent = res?.error ?? "Verification failed.";
    pinError.hidden = false;
    pinInput.value = "";
    pinInput.focus();
  }
});

pinInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("verify").click();
});
// auto-submit once all 6 digits are in, like apple - no Enter needed
pinInput.addEventListener("input", () => {
  if (pinInput.value.trim().length === 6) document.getElementById("verify").click();
});

let noteTimer = null;
function flashNote(text) {
  const el = document.getElementById("refresh-note");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => (el.hidden = true), 2500);
}

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  refreshBtn.classList.add("spinning");
  if (lastState === "needs_pin") {
    // locked: refresh means "get me a fresh code on the mac"
    pinError.hidden = true;
    pinInput.value = "";
    const res = await send({ type: "requestChallenge" });
    if (res?.ok) render(res.state);
    else {
      pinError.textContent = res?.error ?? "Couldn't request a code.";
      pinError.hidden = false;
    }
  } else {
    // unlocked: drop cached passwords, re-fill the page with a fresh read (a password just
    // changed in the Passwords app lands without re-clicking Fill), then re-list
    const r = await send({ type: "refreshAndRefill" });
    await renderLogins();
    if (r?.refilled) flashNote(`Re-filled ${r.username} with the latest password`);
    else flashNote("Passwords refreshed");
  }
  refreshBtn.classList.remove("spinning");
  refreshBtn.disabled = false;
});

document.getElementById("newcode").addEventListener("click", async () => {
  pinError.hidden = true;
  const res = await send({ type: "requestChallenge" });
  if (res?.ok) render(res.state);
  else {
    pinError.textContent = res?.error ?? "Couldn't request a code.";
    pinError.hidden = false;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "state") render(msg.state);
});

(async () => {
  const res = await send({ type: "getState" });
  let state = res?.state ?? "disconnected";
  if (state === "needs_pin") {
    // trigger the macOS access prompt right away
    const ch = await send({ type: "requestChallenge" });
    state = ch?.state ?? state;
  }
  render(state);
})();
