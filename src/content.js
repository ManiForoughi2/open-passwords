// OTP inputs are never fillable login fields, that misclassification is apple's balloon-on-every-OTP bug
console.log("[Open Passwords] content script v0.49.0 loaded");

const OTP_AUTOCOMPLETE = /one-time-code/i;
const OTP_HINT = /\b(otp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|passcode)\b/i;

function attrBlob(el) {
  // snapchat's web login leaves the input bare and labels it via <label>/aria-labelledby
  let labelText = "";
  try {
    if (el.labels?.length) labelText = Array.from(el.labels, (l) => l.textContent).join(" ");
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      labelText += " " + lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || "").join(" ");
    }
  } catch {}
  return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("autocomplete"), labelText]
    .filter(Boolean)
    .join(" ");
}

function isOtpField(el) {
  const ac = el.getAttribute("autocomplete") || "";
  if (OTP_AUTOCOMPLETE.test(ac)) return true;
  const max = parseInt(el.getAttribute("maxlength") || "0", 10);
  if (el.inputMode === "numeric" && max === 1) return true;
  if (OTP_HINT.test(attrBlob(el))) return true;
  return false;
}

function isPasswordField(el) {
  return el instanceof HTMLInputElement && el.type === "password";
}

// a show-password toggle flips type to text at submit, which hid these from the collector
const everPassword = new WeakSet();

function isPasswordish(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === "password") return true;
  if (everPassword.has(el)) return true;
  const t = (el.type || "text").toLowerCase();
  if (!["text", ""].includes(t)) return false;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("password")) return true;
  return /passw|pwd/i.test(attrBlob(el));
}

const NONLOGIN_HINT =
  /\b(search|find|filter|query|lookup|tag|tags|mention|comment|reply|message|chat|post|caption|note|subject|topic|recipient|address|street|city|state|zip|postal|country|first[\s-]?name|last[\s-]?name|full[\s-]?name|company|title|url|website|coupon|promo|voucher|gift[\s-]?card|amount|quantity|qty|price|card[\s-]?number|cvv|cvc|expiry|account[\s-]?(?:number|no|holder)|routing|iban|invoice|order|tracking|keyword)\b/i;

function isSearchOrComboField(el) {
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "searchbox" || role === "combobox") return true;
  if ((el.type || "").toLowerCase() === "search") return true;
  if ((el.getAttribute("enterkeyhint") || "").toLowerCase() === "search") return true;
  const aac = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
  if (aac === "list" || aac === "both" || aac === "inline") return true;
  return false;
}

function pageHasVisiblePassword(field) {
  if (Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible)) return true;
  const root = field?.getRootNode?.();
  if (root && root !== document && root.querySelectorAll) {
    return Array.from(root.querySelectorAll('input[type="password"]')).some(isVisible);
  }
  return false;
}

function hasStrongIdentitySignal(el) {
  const t = (el.type || "text").toLowerCase();
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  // wells fargo and nintendo mark their username box autocomplete=webauthn
  if (ac.includes("username") || ac.includes("email") || ac.includes("webauthn")) return true;
  if (t === "email") return true;
  return /\b(e[\s-]?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|username|passkey)\b/i.test(attrBlob(el));
}

const LOGINISH = /log[\s_-]?in|sign[\s_-]?in|auth|session|sso|oauth|account|idp|passport/i;

// gates the two-step case where no password field exists yet
function loginishContext(el) {
  if (LOGINISH.test(location.hostname + location.pathname)) return true;
  const form = el.form;
  if (form && LOGINISH.test(form.getAttribute("action") || "")) return true;
  const scope = form || document;
  return Array.from(scope.querySelectorAll("button, input[type=submit]")).some((b) =>
    /\b(sign[\s-]?in|log[\s-]?in|continue|next)\b/i.test(b.textContent || b.value || ""),
  );
}

function isUsernameField(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (isOtpField(el)) return false;
  if (isSearchOrComboField(el)) return false;
  const t = (el.type || "text").toLowerCase();
  if (!["text", "email", "tel", ""].includes(t)) return false;

  // "E-mail address" contains "address", which NONLOGIN_HINT would reject (nintendo)
  if (hasStrongIdentitySignal(el)) return true;

  const blob = attrBlob(el);
  if (NONLOGIN_HINT.test(blob)) return false;
  return /\b(user|login|signin|sign[\s-]?in|loginid)\b/i.test(blob);
}

// native setter + input/change so react/vue re-sync, else login fails until you edit a char
function setValue(el, value) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function isVisible(el) {
  if (!el.isConnected) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) < 0.1) return false;
  return true;
}

// hidden/manager-only fields are fine, block the clickjacking shapes (1px, opacity:0, offscreen)
function isFillable(el) {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);

  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
  if (el.offsetParent === null && s.position !== "fixed") return true;

  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  if (parseFloat(s.opacity) < 0.1) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
    // below the fold is legit, only far-offscreen exfil coords are hostile
    if (r.left < -1000 || r.top < -1000 || r.left > vw + 5000) return false;
  }
  return true;
}

function fillCredentials(username, password, anchor) {
  const pool = new Set(document.querySelectorAll("input"));
  const root = anchor?.getRootNode?.();
  if (root && root !== document && root.querySelectorAll) {
    for (const i of root.querySelectorAll("input")) pool.add(i);
  }
  const inputs = Array.from(pool).filter(isFillable);
  let passwords = inputs.filter(isPasswordField);
  let usernames = inputs.filter(isUsernameField);

  const anchorForm = anchor && anchor.form;
  if (anchorForm) {
    const pwInForm = passwords.filter((p) => p.form === anchorForm);
    const userInForm = usernames.filter((u) => u.form === anchorForm);
    if (pwInForm.length) passwords = pwInForm;
    if (userInForm.length) usernames = userInForm;
  }

  let firstPw = passwords[0];
  if (anchor && passwords.length > 1) {
    firstPw = passwords
      .map((p) => ({ p, d: Math.abs(domDistance(anchor, p)) }))
      .sort((a, b) => a.d - b.d)[0].p;
  }

  let userTarget = null;
  if (username) {
    if (anchor && isUsernameField(anchor)) userTarget = anchor;
    else if (usernames.length) {
      userTarget = usernames[0];
      if (firstPw) {
        const before = usernames.filter((u) => u.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (before.length) userTarget = before[before.length - 1];
      }
    }
  }

  let filled = false;
  if (userTarget) {
    setValue(userTarget, username);
    filled = true;
  }
  if (password && firstPw) {
    setValue(firstPw, password);
    everPassword.add(firstPw);
    filled = true;
  }
  return filled;
}

function domDistance(a, b) {
  const all = Array.from(document.querySelectorAll("input"));
  return all.indexOf(a) - all.indexOf(b);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "fill") return false;
  // host must match the origin the background pinned the cred to, so site A's cred never lands on site B
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, filled: false, error: "forbidden" });
    return true;
  }
  if (msg.expectedHost && location.hostname.toLowerCase() !== msg.expectedHost) {
    sendResponse({ ok: false, filled: false, error: "origin mismatch" });
    return true;
  }
  const filled = fillCredentials(msg.username, msg.password, liveField(fillAnchor));
  // a submit right after must not re-offer to save this existing login
  if (filled) lastAutofill = { host: location.hostname, username: msg.username, password: msg.password, at: Date.now() };
  sendResponse({ ok: true, filled });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg?.type) {
    case "fillOtp": {
      if (msg.expectedHost && location.hostname.toLowerCase() !== msg.expectedHost) {
        sendResponse({ ok: false, filled: false, error: "origin mismatch" });
        return true;
      }
      // a frame with no code field stays silent so another frame's answer wins
      const target = otpTargetField();
      if (!target) return false;
      fillOtp(target, msg.code);
      sendResponse({ ok: true, filled: true });
      return true;
    }
    case "oneTimeCodeAvailable": {
      const a = deepActiveElement();
      if (a instanceof HTMLInputElement && isOtpField(a) && isVisible(a) && frameIsSafe()) {
        buildOneTimeCodeSuggestion(a);
      }
      return false;
    }
    case "shortcut": {
      onShortcut();
      return false;
    }
    case "unlocked": {
      // auto-pair opened the vault while the inline PIN box was up
      if (suggestionEl && typeof lockedResume === "function") lockedResume();
      return false;
    }
    case "findTotpUri": {
      if (window !== window.top) return false;
      sendResponse({ uris: findTotpUris() });
      return true;
    }
  }
  return false;
});

let fillAnchor = null;
let otpAnchor = null;
let lockedResume = null;
// suppresses a save offer for a login just filled from the vault
let lastAutofill = null;
// its submit always offers to save (reset page / password change)
let lastGenerated = null;

let suggestionEl = null;
let anchorField = null;
let cachedLogins = null;
let navItems = [];
let navIndex = -1;

function isLoginField(el) {
  if (!isVisible(el)) return false;

  if (isPasswordField(el)) return true;

  if (!isUsernameField(el)) return false;

  const form = el.form;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();

  // explicit autocomplete=username is intentional even when the password lives in another form
  if (ac.includes("username")) return true;

  // beats autocomplete=off, which banks (wells fargo) set to block autofill, chrome/1password ignore it too
  if (form && Array.from(form.querySelectorAll("input")).some(isPasswordField)) return true;

  const formOptedOut = form && (form.getAttribute("autocomplete") || "").toLowerCase() === "off";
  if (formOptedOut) return false;

  // without this it fires on tag/search/newsletter boxes
  if (pageHasVisiblePassword(el)) return true;

  // two-step first page, no password anywhere yet
  if (hasStrongIdentitySignal(el) && loginishContext(el)) return true;

  return false;
}

function removeSuggestion() {
  if (suggestionEl) {
    suggestionEl.remove();
    suggestionEl = null;
  }
  anchorField = null;
  navItems = [];
  navIndex = -1;
  lockedResume = null;
}

function setActiveNav(i) {
  navIndex = i;
  navItems.forEach((it, idx) => {
    const on = idx === i;
    it.el.style.background = on ? "rgba(10,132,255,0.18)" : "transparent";
    if (on) it.el.setAttribute("aria-selected", "true");
    else it.el.removeAttribute("aria-selected");
  });
  if (i >= 0 && navItems[i]) navItems[i].el.scrollIntoView({ block: "nearest" });
}

function registerRow(row, onActivate) {
  row.setAttribute("role", "option");
  const idx = navItems.length;
  navItems.push({ el: row, onActivate });
  row.addEventListener("mouseenter", () => setActiveNav(idx));
  // act on click not mousedown so the click cant land on a link behind the box (x.com forgot password, issue #2)
  row.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    rowPressAt = Date.now();
  });
  row.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate();
  });
}

// a click that follows a row press but reaches the page (box torn down in between) must not act on the page
let rowPressAt = 0;
document.addEventListener(
  "click",
  (e) => {
    if (!rowPressAt || Date.now() - rowPressAt > 700) return;
    if (suggestionEl && suggestionEl.contains(e.target)) return;
    rowPressAt = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  true,
);

function onSuggestionKeydown(e) {
  if (!e.isTrusted) return;
  if (!suggestionEl) return;
  if (e.key === "Escape") {
    removeSuggestion();
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!navItems.length || e.target !== anchorField) return;
  if (e.key === "ArrowDown") {
    setActiveNav((navIndex + 1) % navItems.length);
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    setActiveNav((navIndex - 1 + navItems.length) % navItems.length);
    e.preventDefault();
  } else if (e.key === "Enter" && navIndex >= 0) {
    e.preventDefault();
    e.stopPropagation();
    navItems[navIndex].onActivate();
  }
}

function positionBox() {
  if (!suggestionEl || !anchorField) return;
  if (!anchorField.isConnected || !isVisible(anchorField)) {
    removeSuggestion();
    return;
  }
  const r = anchorField.getBoundingClientRect();
  suggestionEl.style.left = `${window.scrollX + r.left}px`;
  suggestionEl.style.minWidth = `${Math.max(r.width, 200)}px`;
  const h = suggestionEl.offsetHeight || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.bottom + 2 + h > vh && r.top - 2 - h > 0) {
    suggestionEl.style.top = `${window.scrollY + r.top - h - 2}px`;
  } else {
    suggestionEl.style.top = `${window.scrollY + r.bottom + 2}px`;
  }
}

const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Open Runde", system-ui, sans-serif';

let fontFaceInjected = false;
function ensureFontFace() {
  if (fontFaceInjected) return;
  fontFaceInjected = true;
  try {
    const css = [
      ["Regular", 400],
      ["Medium", 500],
      ["Semibold", 600],
    ]
      .map(
        ([w, n]) =>
          `@font-face{font-family:"Open Runde";font-weight:${n};font-display:swap;src:url("${chrome.runtime.getURL(`fonts/OpenRunde-${w}.woff2`)}") format("woff2");}`,
      )
      .join("");
    const st = document.createElement("style");
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  } catch {}
}

// solid Canvas stays as the fallback where light-dark() is unsupported
function glassify(el) {
  Object.assign(el.style, {
    background: "Canvas",
    color: "CanvasText",
    colorScheme: "light dark",
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: "14px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.10)",
    backdropFilter: "blur(24px) saturate(180%)",
    webkitBackdropFilter: "blur(24px) saturate(180%)",
    overflow: "hidden",
    font: `13px/1.4 ${UI_FONT}`,
  });
  el.style.setProperty("background", "light-dark(rgba(252,252,253,0.72), rgba(28,28,30,0.66))");
  el.style.setProperty("border-color", "light-dark(rgba(0,0,0,0.10), rgba(255,255,255,0.14))");
  el.style.setProperty(
    "box-shadow",
    "0 12px 32px rgba(0,0,0,0.22), inset 0 0.5px 0 light-dark(rgba(255,255,255,0.75), rgba(255,255,255,0.12))",
  );
}

function buildSuggestionBox(field) {
  removeSuggestion();
  ensureFontFace();
  anchorField = field;
  const box = document.createElement("div");
  box.setAttribute("data-open-passwords", "suggestions");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Open Passwords suggestions");
  glassify(box);
  Object.assign(box.style, {
    position: "absolute",
    zIndex: "2147483647",
  });
  const header = document.createElement("div");
  header.textContent = "Open Passwords";
  Object.assign(header.style, {
    padding: "7px 12px",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0.02em",
    opacity: "0.55",
    borderBottom: "1px solid rgba(128,128,128,0.18)",
  });
  box.appendChild(header);
  document.body.appendChild(box);
  suggestionEl = box;
  positionBox();
  return box;
}

async function buildLockedSuggestion(field, onUnlock) {
  const box = buildSuggestionBox(field);

  const msg = document.createElement("div");
  msg.textContent = "Enter the code shown on your Mac";
  Object.assign(msg.style, { padding: "8px 10px 4px", fontSize: "12px", opacity: "0.7" });
  box.appendChild(msg);

  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.maxLength = 6;
  input.placeholder = "------";
  Object.assign(input.style, {
    margin: "4px 12px 8px",
    width: "calc(100% - 24px)",
    padding: "9px",
    font: `16px ${UI_FONT}`,
    letterSpacing: "5px",
    textAlign: "center",
    border: "1px solid rgba(128,128,128,0.35)",
    borderRadius: "10px",
    background: "Canvas",
    color: "CanvasText",
    boxSizing: "border-box",
  });
  input.style.setProperty("background", "light-dark(rgba(255,255,255,0.55), rgba(0,0,0,0.28))");
  box.appendChild(input);

  const status = document.createElement("div");
  Object.assign(status.style, { padding: "0 10px 8px", fontSize: "12px", color: "#ff453a", minHeight: "14px" });
  box.appendChild(status);

  input.addEventListener("mousedown", (e) => e.stopPropagation());

  const setStatus = (text, isError) => {
    status.style.color = isError ? "#ff453a" : "rgba(128,128,128,0.9)";
    status.textContent = text;
  };

  const again = document.createElement("div");
  again.textContent = "Get a new code";
  Object.assign(again.style, {
    padding: "0 12px 10px",
    fontSize: "12px",
    opacity: "0.7",
    cursor: "pointer",
    textDecoration: "underline",
  });
  again.addEventListener("mousedown", (e) => e.stopPropagation());
  again.addEventListener("click", async () => {
    setStatus("Asking your Mac for a new code...", false);
    input.value = "";
    await chrome.runtime.sendMessage({ type: "requestChallenge" }).catch(() => {});
    setStatus("Enter the new code on your Mac", false);
    input.focus();
  });
  box.appendChild(again);

  // a second prompt would invalidate the code the user is reading
  chrome.runtime.sendMessage({ type: "requestChallenge", ifNeeded: true }).catch(() => {});

  // also reached from the background's "unlocked" message via lockedResume
  const finishUnlock = async () => {
    lockedResume = null;
    if (typeof onUnlock === "function") {
      removeSuggestion();
      onUnlock();
      return;
    }
    cachedLogins = null;
    const r2 = await chrome.runtime.sendMessage({ type: "inlineLogins" }).catch(() => null);
    cachedLogins = r2?.logins || [];
    if (cachedLogins.length === 1) {
      removeSuggestion();
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: cachedLogins[0] }).catch(() => {});
    } else if (cachedLogins.length > 1) {
      buildChooser(field, cachedLogins);
    } else {
      removeSuggestion();
    }
  };
  lockedResume = finishUnlock;

  let verifying = false;
  const doVerify = async () => {
    if (verifying) return;
    const pin = input.value.trim();
    if (pin.length < 4) return;
    verifying = true;
    setStatus("Verifying...", false);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "verifyPin", pin });
    } catch (err) {
      verifying = false;
      setStatus("Verification failed, try again", true);
      return;
    }
    verifying = false;
    if (res?.ok && res.state === "unlocked") {
      finishUnlock();
    } else {
      // the attempt burned that challenge, so the background already put a new code on the Mac
      const base = res?.error || "Verification failed";
      setStatus(res?.newCode ? `${base} - enter the new code on your Mac` : base, true);
      input.value = "";
      input.focus();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    if (e.key === "Enter") doVerify();
  });
  input.addEventListener("input", () => {
    if (input.value.trim().length === 6) doVerify();
  });

  setTimeout(() => input.focus(), 0);
}

function isNewPasswordField(el) {
  if (!isPasswordField(el)) return false;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("current-password")) return false;
  if (ac.includes("new-password")) return true;
  const pwCount = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible).length;
  if (pwCount >= 2) return true;
  return Array.from(document.querySelectorAll("button, input[type=submit], input[type=button]")).some((b) =>
    /\b(sign[\s-]?up|register|create[\s-]?account|create[\s-]?your[\s-]?account)\b/i.test(b.textContent || b.value || ""),
  );
}

function randBelow(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}
function pickFrom(set) {
  return set[randBelow(set.length)];
}

// apple's Strong Password (per rmondello): 20 chars, three CVCCVC syllables hyphenated, 1 upper + 1 digit
function generateApplePassword() {
  const C = "bcdfghjkmnpqrstvwxz"; // no ambiguous 'l'
  const V = "aeiouy";
  const groups = [];
  for (let g = 0; g < 3; g++) {
    groups.push([pickFrom(C), pickFrom(V), pickFrom(C), pickFrom(C), pickFrom(V), pickFrom(C)]);
  }
  // digit goes either side of a hyphen or at the end, per apple
  const digitSlots = [[0, 5], [1, 0], [1, 5], [2, 0], [2, 5]];
  const [dg, dp] = digitSlots[randBelow(digitSlots.length)];
  groups[dg][dp] = String(randBelow(10));
  let ug, up;
  do {
    ug = randBelow(3);
    up = randBelow(6);
  } while (ug === dg && up === dp);
  groups[ug][up] = groups[ug][up].toUpperCase();
  return groups.map((g) => g.join("")).join("-");
}

// apple's "Without Special Characters" fallback, 15 chars matches apple's own output
function generateAlphanumericPassword(len = 15) {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digit = "0123456789";
  const all = lower + upper + digit;
  const chars = [pickFrom(lower), pickFrom(upper), pickFrom(digit)];
  while (chars.length < len) chars.push(pickFrom(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randBelow(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// react can remount the input between dropdown build and click, so re-resolve the node
function liveField(field) {
  if (!field || field.isConnected) return field;
  if (field.id) {
    const byId = document.getElementById(field.id);
    if (byId instanceof HTMLInputElement) return byId;
  }
  if (field.name) {
    const byName = document.querySelector(`input[name="${CSS.escape(field.name)}"]`);
    if (byName instanceof HTMLInputElement) return byName;
  }
  return anchorPwField(document) || field;
}

function fillGeneratedPassword(field, pw) {
  field = liveField(field);
  const targets = new Set([field]);
  for (const p of Array.from(document.querySelectorAll('input[type="password"]')).filter(isFillable)) {
    if (p === field || p.value) continue;
    if (p.form && field.form && p.form !== field.form) continue;
    targets.add(p);
  }
  for (const t of targets) {
    setValue(t, pw);
    everPassword.add(t);
  }
  lastGenerated = { host: location.hostname, password: pw, at: Date.now() };
}

// fill routes through the origin-checked background path, page never sees the password
function appendLoginRows(box, field, logins) {
  for (const login of logins) {
    const row = document.createElement("div");
    row.textContent = login.username || "(no username)";
    Object.assign(row.style, {
      padding: "8px 12px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    registerRow(row, () => {
      removeSuggestion();
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: login });
    });
    box.appendChild(row);
  }
}

function appendGeneratorOptions(box, field, separatorAbove) {
  const options = [
    { label: "Strong Password", value: generateApplePassword() },
    { label: "Without Special Characters", value: generateAlphanumericPassword() },
  ];
  options.forEach((opt, idx) => {
    const item = document.createElement("div");
    item.setAttribute("data-op-generate", "1");
    Object.assign(item.style, {
      padding: "8px 12px",
      cursor: "pointer",
      borderTop: idx === 0 && separatorAbove ? "1px solid rgba(128,128,128,0.25)" : "none",
    });
    const label = document.createElement("div");
    label.textContent = opt.label;
    Object.assign(label.style, { fontWeight: "600", fontSize: "13px" });
    const preview = document.createElement("div");
    preview.textContent = opt.value;
    Object.assign(preview.style, {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "12px",
      opacity: "0.65",
      marginTop: "2px",
    });
    item.append(label, preview);
    registerRow(item, () => {
      fillGeneratedPassword(field, opt.value);
      removeSuggestion();
    });
    box.appendChild(item);
  });
}

function deepActiveElement() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

// a stale async read from an earlier focus must not draw over a newer one
let offerSeq = 0;

// fetch before building so an empty result never flashes a box on then off
async function buildOfferSuggestion(field) {
  const hasGenerator = isNewPasswordField(field);
  const seq = ++offerSeq;

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "inlineLogins" });
  } catch {
    res = null;
  }
  if (seq !== offerSeq || field !== deepActiveElement()) return;

  const locked = !!(res?.ok && res.locked);
  const logins = res?.ok && !locked ? res.logins || [] : [];
  if (!locked && !logins.length && !hasGenerator) return;

  const box = buildSuggestionBox(field);
  if (locked) {
    const row = document.createElement("div");
    row.textContent = "Unlock to autofill…";
    Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
    registerRow(row, () => buildLockedSuggestion(field));
    box.appendChild(row);
    if (hasGenerator) appendGeneratorOptions(box, field, true);
    positionBox();
    return;
  }

  if (logins.length) appendLoginRows(box, field, logins);
  if (hasGenerator) appendGeneratorOptions(box, field, logins.length > 0);
  positionBox(); // final height known now
}

// codes are always an offer behind a click, never filled because a field appeared, a code is a bearer credential
let otpFilling = false;

function otpBoxGroup(el) {
  const scope = el.form || el.closest("div, section, fieldset") || document;
  const inputs = Array.from(scope.querySelectorAll("input")).filter(
    (i) => isVisible(i) && !i.disabled && !i.readOnly
  );
  // spotify sets no maxlength and clamps in JS, so a shared one-time-code autocomplete also marks a row
  const sized = inputs.filter((i) => parseInt(i.getAttribute("maxlength") || "0", 10) === 1);
  if (sized.includes(el) && sized.length >= 4) return sized;
  const tagged = inputs.filter((i) => OTP_AUTOCOMPLETE.test(i.getAttribute("autocomplete") || ""));
  if (tagged.includes(el) && tagged.length >= 4) return tagged;
  return null;
}

function fillOtp(field, code) {
  const chars = code.replace(/[^A-Za-z0-9]/g, "").split("");
  const boxes = otpBoxGroup(field);
  otpFilling = true;
  try {
    if (!boxes) {
      field.focus();
      setValue(field, chars.join(""));
      return;
    }
    const start = Math.max(0, boxes.indexOf(field));
    chars.forEach((c, i) => {
      const box = boxes[start + i];
      if (!box) return;
      box.focus();
      setValue(box, c);
      // some widgets advance focus on keyup rather than on input
      box.dispatchEvent(new KeyboardEvent("keydown", { key: c, bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: c, bubbles: true }));
    });
    boxes[Math.min(start + chars.length - 1, boxes.length - 1)]?.focus();
  } finally {
    // release after the focus events settle
    setTimeout(() => { otpFilling = false; }, 0);
  }
}

function otpTargetField() {
  const anchored = liveField(otpAnchor);
  if (anchored instanceof HTMLInputElement && anchored.isConnected && isOtpField(anchored)) return anchored;
  const a = deepActiveElement();
  if (a instanceof HTMLInputElement && isOtpField(a) && isVisible(a)) return a;
  return Array.from(document.querySelectorAll("input")).find((i) => isOtpField(i) && isVisible(i)) || null;
}

// no innerHTML on a page we dont control
function codeIcon() {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.style.opacity = "0.5";
  svg.style.flex = "none";
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", "12");
  ring.setAttribute("cy", "12");
  ring.setAttribute("r", "9");
  const hands = document.createElementNS(NS, "path");
  hands.setAttribute("d", "M12 7v5l3 2");
  svg.append(ring, hands);
  return svg;
}

function appendOneTimeCodeRows(box, field, rows) {
  for (const r of rows) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      padding: "8px 12px",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: "9px",
    });
    row.appendChild(codeIcon());
    const text = document.createElement("div");
    Object.assign(text.style, { minWidth: "0" });
    const label = document.createElement("div");
    label.textContent =
      r.source === "totp"
        ? r.domain
          ? `Verification code for ${r.domain}`
          : "Verification code"
        : "Code from Messages";
    Object.assign(label.style, { fontWeight: "600", fontSize: "13px" });
    text.appendChild(label);
    if (r.username) {
      const sub = document.createElement("div");
      sub.textContent = r.username;
      Object.assign(sub.style, {
        fontSize: "12px",
        opacity: "0.65",
        marginTop: "1px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
      text.appendChild(sub);
    }
    row.appendChild(text);
    registerRow(row, () => {
      removeSuggestion();
      otpAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFillOneTimeCode", id: r.id }).catch(() => {});
    });
    box.appendChild(row);
  }
}

async function buildOneTimeCodeSuggestion(field) {
  if (otpFilling) return;
  const seq = ++offerSeq;
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "inlineOneTimeCodes" });
  } catch {
    return;
  }
  if (seq !== offerSeq) return;
  // a split widget moves focus between its boxes during the lookup (react can swap the node), accept any box in the group
  const active = deepActiveElement();
  const group = otpBoxGroup(field);
  if (!field.isConnected || !(active === field || (group && group.includes(active)))) return;
  if (active !== field && active instanceof HTMLInputElement) field = active;
  if (!res?.ok) return;
  const locked = !!res.locked;
  const rows = res.rows || [];
  // a locked vault is worth a row only if this helper can offer codes at all
  if (!locked && !rows.length) return;
  if (locked && res.supported === false) return;

  const box = buildSuggestionBox(field);
  if (locked) {
    const row = document.createElement("div");
    row.textContent = "Unlock to fill verification codes…";
    Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
    registerRow(row, () => buildLockedSuggestion(field, () => buildOneTimeCodeSuggestion(field)));
    box.appendChild(row);
    positionBox();
    return;
  }
  appendOneTimeCodeRows(box, field, rows);
  positionBox();
}

// no image or QR scanning here, on purpose
function findTotpUris() {
  const found = [];
  const add = (s) => {
    s = (s || "").trim();
    if (/^(apple-)?otpauth:\/\/[^\s"'<>]+$/i.test(s) && !found.includes(s) && found.length < 3) found.push(s);
  };
  for (const a of document.querySelectorAll('a[href^="otpauth://"], a[href^="apple-otpauth://"]')) add(a.getAttribute("href"));
  for (const i of document.querySelectorAll("input, textarea")) if (/^(apple-)?otpauth:/i.test(i.value || "")) add(i.value);
  const re = /(?:apple-)?otpauth:\/\/[^\s"'<>]+/gi;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n;
  let budget = 5000; // keeps a huge page cheap
  while ((n = walker.nextNode()) && budget-- > 0) {
    const t = n.nodeValue;
    if (!t || t.length < 12 || !/otpauth:/i.test(t)) continue;
    for (const m of t.match(re) || []) add(m);
  }
  return found;
}

function onShortcut() {
  const a = deepActiveElement();
  if (a instanceof HTMLInputElement && isVisible(a) && frameIsSafe()) {
    if (isOtpField(a)) return void buildOneTimeCodeSuggestion(a);
    if (isLoginField(a)) return void buildOfferSuggestion(a);
  }
  if (window !== window.top) return;
  const target = Array.from(document.querySelectorAll("input")).find((i) => isVisible(i) && isLoginField(i));
  if (target) target.focus();
}

function buildChooser(field, logins) {
  if (!logins.length) {
    removeSuggestion();
    return;
  }
  const box = buildSuggestionBox(field);
  appendLoginRows(box, field, logins);
}

// excludes generic app hosting (firebaseapp, vercel) where anyone can deploy
const IFRAME_LOGIN_ALLOWLIST = [
  "accounts.google.com", "adyen.com", "affirm.com", "afterpay.com", "amazon.com", "amazoncognito.com",
  "appleid.apple.com", "atlassian.com", "auth0.com", "authkit.app", "awsapps.com", "b2clogin.com",
  "beyondidentity.com", "cash.app", "ciamlogin.com", "clearpay.co.uk", "clerk.accounts.dev", "clerk.com",
  "corbado.io", "cyberark.cloud", "delinea.app", "descope.com", "descope.io", "discord.com",
  "dropbox.com", "duosecurity.com", "dynamicauth.com", "facebook.com", "finicity.com", "force.com",
  "forgeblocks.com", "forgerock.com", "forgerock.io", "frontegg.com", "fusionauth.io", "github.com",
  "gitlab.com", "hanko.io", "idaptive.app", "jumpcloud.com", "kakao.com", "kinde.com", "klarna.com",
  "line.me", "link.com", "linkedin.com", "live.com", "loginradius.com", "magic.link",
  "microsoftonline.com", "mojoauth.com", "moneydesktop.com", "naver.com", "okta-emea.com", "okta.com",
  "oktapreview.com", "onelogin.com", "openlogin.com", "ory.sh", "oryapis.com", "paypal.com",
  "phasetwo.io", "ping-eng.com", "pingidentity.com", "pingone.com", "plaid.com", "privy.io",
  "propelauth.com", "propelauthtest.com", "razorpay.com", "reddit.com", "sailpoint.com", "salesforce.com",
  "secureauth.com", "securid.com", "shop.app", "shopify.com", "slack.com", "spotify.com", "stripe.com",
  "stytch.com", "supertokens.com", "tink.com", "transmitsecurity.io", "truelayer.com", "twitch.tv",
  "twitter.com", "userfront.com", "venmo.com", "verify.ibm.com", "vk.com", "web3auth.io", "workos.com",
  "x.com", "xecurify.com", "yahoo.com", "yandex.com", "yandex.ru", "zitadel.cloud",
];

// suffix match so "clerk.accounts.dev" matches without matching a bare "accounts.dev"
function isAllowlistedLoginHost(host) {
  host = host.toLowerCase();
  return IFRAME_LOGIN_ALLOWLIST.some((d) => host === d || host.endsWith("." + d));
}

function frameIsSafe() {
  if (window === window.top) return true;
  if (isAllowlistedLoginHost(location.hostname)) return true;
  try {
    return location.origin === window.top.location.origin;
  } catch {
    return false;
  }
}

async function onFocusIn(e) {
  // focusin from inside a shadow root retargets to the host, composedPath has the real input
  const field = (e.composedPath ? e.composedPath()[0] : null) || e.target;
  if (field instanceof HTMLInputElement && field.type === "password") everPassword.add(field);
  if (field instanceof HTMLInputElement && isOtpField(field) && isVisible(field)) {
    if (frameIsSafe()) buildOneTimeCodeSuggestion(field);
    return;
  }
  if (!(field instanceof HTMLInputElement) || !isLoginField(field)) {
    return;
  }
  if (!frameIsSafe()) return;
  // still offer on a pre-filled field (apple/chrome do), only stay quiet if we just filled it
  const v = (field.value || "").trim();
  if (v) {
    const justOurs =
      lastAutofill &&
      lastAutofill.host === location.hostname &&
      Date.now() - lastAutofill.at < 8000 &&
      (v === (lastAutofill.username || "") || v === (lastAutofill.password || ""));
    if (justOurs) {
      removeSuggestion();
      return;
    }
  }
  buildOfferSuggestion(field);
}

document.addEventListener("focusin", onFocusIn, true);
// capture so Enter is intercepted before the page's own submit handling
document.addEventListener("keydown", onSuggestionKeydown, true);
// focusing auto-scrolls the field, which used to fire this and kill the offer
document.addEventListener("scroll", positionBox, true);
window.addEventListener("resize", positionBox, true);
// focus moving into the box (inline PIN field) is kept
document.addEventListener(
  "focusout",
  (e) => {
    if (!suggestionEl || e.target !== anchorField) return;
    if (e.relatedTarget && suggestionEl.contains(e.relatedTarget)) return;
    removeSuggestion();
  },
  true,
);
document.addEventListener(
  "mousedown",
  (e) => {
    if (!suggestionEl) return;
    if (suggestionEl.contains(e.target)) return;
    if (e.target === anchorField) return;
    // another login field's focusin rebuilds the offer, closing here first would race
    if (e.target instanceof HTMLInputElement && isLoginField(e.target)) return;
    removeSuggestion();
  },
  true,
);

let lastSaveKey = "";
let lastSaveAt = 0;

const SUBMITY_LABEL =
  /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|reset|confirm|done|set|apply|activate|enroll|finish|proceed|verify|join|change[\s-]?password|continue|next|submit)\b/i;

// ids and names carry no word boundaries ("findpwd", "loginBtn"), so match bare substrings
const SUBMITY_ATTR = /pwd|passw|reset|submit|login|signin|confirm|continue|next|done|save|set|apply/i;

function isSubmitControl(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  const attrs = `${el.getAttribute("name") || ""} ${el.id || ""}`;
  if (tag === "button" && (type === "" || type === "button")) {
    return SUBMITY_LABEL.test((el.textContent || el.value || "") ?? "") || SUBMITY_ATTR.test(attrs);
  }
  // old-school pages (tplink) submit via <input type=button value="OK">
  if (tag === "input" && type === "button") {
    return SUBMITY_LABEL.test(el.value || "") || SUBMITY_ATTR.test(attrs);
  }
  // styled div/a with role=button (sling reset pages)
  if ((el.getAttribute("role") || "").toLowerCase() === "button" || tag === "a") {
    return SUBMITY_LABEL.test((el.textContent || attrBlob(el)) ?? "");
  }
  return false;
}

function collectSubmittedCredentials(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const inputs = Array.from(root.querySelectorAll("input"));
  // a show-password toggle leaves the field type=text at submit
  const pws = inputs.filter((i) => isPasswordish(i) && i.value);
  if (!pws.length) return null;
  // "last" alone saved the OLD password when current sat below new + confirm
  let password = pws[pws.length - 1].value;
  const counts = new Map();
  for (const p of pws) counts.set(p.value, (counts.get(p.value) || 0) + 1);
  const dup = [...counts.entries()].find(([, n]) => n >= 2);
  const marked = pws.find((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));
  if (dup) password = dup[0];
  else if (marked) password = marked.value;
  const firstPw = pws[0];
  const before = (el) => el.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING;

  // a password value in the username slot is what got saved on toggled reset forms
  const pwValues = new Set(pws.map((p) => p.value));
  const usable = (i) => !isPasswordish(i) && !pwValues.has(i.value.trim());

  const strict = inputs.filter((i) => isUsernameField(i) && i.value && usable(i));
  const strictBefore = strict.filter(before);
  let userEl = strictBefore.length ? strictBefore[strictBefore.length - 1] : strict[0] || null;

  // reject junk so a reset doesnt save "9" as the name
  if (!userEl) {
    const looksLikeUsername = (v) => {
      v = (v || "").trim();
      if (v.length < 3) return false;
      if (/^\d+$/.test(v) && v.length < 6) return false; // a short number is a code, not a name
      return true;
    };
    const guess = inputs.filter((i) => {
      if (!i.value || !usable(i)) return false;
      if (isOtpField(i) || isSearchOrComboField(i)) return false;
      const t = (i.type || "text").toLowerCase();
      if (!["text", "email", "tel", ""].includes(t)) return false;
      if (NONLOGIN_HINT.test(attrBlob(i))) return false;
      if (!looksLikeUsername(i.value)) return false;
      return before(i);
    });
    userEl = guess.length ? guess[guess.length - 1] : null;
  }

  // a change form's last field is often the current password, so the caller can spot a generated value that isnt last
  return { username: (userEl?.value || "").trim(), password, allPasswords: pws.map((p) => p.value) };
}

function anchorPwField(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const pws = Array.from(scope.querySelectorAll("input")).filter(isPasswordish);
  return pws.find(isVisible) || pws[0] || null;
}

// awaiting the lookup here lost the save on a redirect
async function maybeOfferSave(scope) {
  if (!frameIsSafe()) return;
  const cred = collectSubmittedCredentials(scope);
  if (!cred || !cred.password) return;

  const genPw =
    lastGenerated && Date.now() - lastGenerated.at < 600000 ? lastGenerated.password : null;
  const generated = !!genPw && (cred.allPasswords || []).includes(genPw);
  const savePassword = generated ? genPw : cred.password;

  // a login we just autofilled unchanged is not a save
  if (
    !generated &&
    lastAutofill &&
    lastAutofill.host === location.hostname &&
    lastAutofill.password === cred.password &&
    Date.now() - lastAutofill.at < 300000
  ) {
    console.debug("[Open Passwords] save skipped: recently autofilled");
    return;
  }

  // 15s covers the click+submit+Enter burst ("shows up twice" fix)
  const key = `${location.hostname} ${cred.username || savePassword}`;
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 15000) return;
  lastSaveKey = key;
  lastSaveAt = now;

  const root = scope && scope.querySelectorAll ? scope : document;
  const pwInputs = Array.from(root.querySelectorAll("input")).filter(isPasswordish);
  const newPwCtx =
    generated ||
    (cred.allPasswords || []).length >= 2 ||
    pwInputs.some((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));

  // fire and forget, awaiting would let a navigating submit kill us
  console.debug("[Open Passwords] handing save to background", {
    host: location.hostname,
    user: cred.username || "(none)",
    generated,
    newPwCtx,
  });
  chrome.runtime
    .sendMessage({
      type: "resolveSave",
      username: cred.username,
      password: savePassword,
      generated,
      newPwCtx,
    })
    .catch(() => {});
}

document.addEventListener(
  "submit",
  (e) => {
    if (!e.isTrusted) return;
    removeSuggestion();
    maybeOfferSave(e.target);
  },
  true,
);
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest('button, input[type=submit], input[type=button], [role="button"], a');
    if (isSubmitControl(ctrl)) maybeOfferSave(ctrl.form || document);
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted || e.key !== "Enter") return;
    const t = e.target;
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) {
      removeSuggestion(); // formless submit, Enter doesnt fire a submit event
      maybeOfferSave(t.form || document);
    }
  },
  true,
);
