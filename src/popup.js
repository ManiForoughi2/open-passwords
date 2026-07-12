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
  // chrome:// pages cant be opened via a link, need tabs.create
  chrome.tabs.create({ url: "chrome://settings/autofill/passwords" });
});

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

async function render(state) {
  setDot(state);
  refreshBtn.hidden = state !== "unlocked";
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

refreshBtn.addEventListener("click", async () => {
  // drop cached passwords then re-list, so a just-changed password shows up
  refreshBtn.disabled = true;
  await send({ type: "clearCache" });
  await renderLogins();
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
