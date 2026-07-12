// fills credentials into the page on request from popup. never treats OTP inputs
// as fillable login fields - that misclassification is apple's balloon-on-every-OTP bug
console.log("[Open Passwords] content script v0.26.0 loaded");

const OTP_AUTOCOMPLETE = /one-time-code/i;
const OTP_HINT = /\b(otp|one[\s-]?time|verification|2fa|mfa|sms[\s-]?code|auth[\s-]?code|security[\s-]?code|passcode)\b/i;

function attrBlob(el) {
  return [el.name, el.id, el.getAttribute("aria-label"), el.placeholder, el.getAttribute("autocomplete")]
    .filter(Boolean)
    .join(" ");
}

function isOtpField(el) {
  const ac = el.getAttribute("autocomplete") || "";
  if (OTP_AUTOCOMPLETE.test(ac)) return true;
  // short numeric single-char boxes look like OTP slots
  const max = parseInt(el.getAttribute("maxlength") || "0", 10);
  if (el.inputMode === "numeric" && max === 1) return true;
  if (OTP_HINT.test(attrBlob(el))) return true;
  return false;
}

function isPasswordField(el) {
  return el instanceof HTMLInputElement && el.type === "password";
}

// never a login even if attrs contain user/email (search, tag, comment, address, checkout)
const NONLOGIN_HINT =
  /\b(search|find|filter|query|lookup|tag|tags|mention|comment|reply|message|chat|post|caption|note|subject|topic|recipient|address|street|city|state|zip|postal|country|first[\s-]?name|last[\s-]?name|full[\s-]?name|company|title|url|website|coupon|promo|voucher|gift[\s-]?card|amount|quantity|qty|price|card[\s-]?number|cvv|cvc|expiry|account[\s-]?(?:number|no|holder)|routing|iban|invoice|order|tracking|keyword)\b/i;

// search/combobox/picker (e.g. instagram tag box) is not a login
function isSearchOrComboField(el) {
  const role = (el.getAttribute("role") || "").toLowerCase();
  if (role === "searchbox" || role === "combobox") return true;
  if ((el.type || "").toLowerCase() === "search") return true;
  if ((el.getAttribute("enterkeyhint") || "").toLowerCase() === "search") return true;
  const aac = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
  if (aac === "list" || aac === "both" || aac === "inline") return true;
  return false;
}

// formless/SPA fallback: recognise logins not wrapped in a form without firing on
// search/tag/newsletter boxes that have no password in sight
function pageHasVisiblePassword() {
  return Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible);
}

function isUsernameField(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (isOtpField(el)) return false;
  if (isSearchOrComboField(el)) return false;
  const t = (el.type || "text").toLowerCase();
  if (!["text", "email", "tel", ""].includes(t)) return false;

  const blob = attrBlob(el);
  // reject search/tag/comment/address/checkout even if it also has user/email/account
  // ("account number", "search users", "email a friend", "tag a user")
  if (NONLOGIN_HINT.test(blob)) return false;

  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  if (ac.includes("username")) return true;
  // autocomplete=email is a candidate but the login gate (needs a password nearby)
  // decides, so a lone newsletter email box wont pass on its own
  if (ac.includes("email")) return true;
  // a bare type=email input is an identifier even with no autocomplete attr (how most signups
  // mark the username). NONLOGIN_HINT + the password-nearby gate keep newsletter boxes out
  if (t === "email") return true;
  // require a login-specific token, bare account substrings are too broad
  return /\b(user(name)?|login|signin|sign[\s-]?in|userid|loginid|e[\s-]?mail)\b/i.test(blob);
}

// use the native prototype value setter: react/vue/angular patch the element's own
// `value`, so bypass that and fire input/change to re-sync framework controlled state.
// fixes the "login fails until you edit a char" bug without faking keystrokes
function setValue(el, value) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// genuinely shown to the user - gates whether to OFFER the dropdown
function isVisible(el) {
  if (!el.isConnected) return false;
  if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  if (s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) < 0.1) return false;
  return true;
}

// safe to write a credential into. more permissive than isVisible, matching apple/chrome:
// legit hidden fields (display:none/visibility:hidden the site reveals later, or a hidden
// username the manager reads) are fillable. blocks the clickjacking pattern - a field kept
// IN LAYOUT but rendered invisible to steal a fill: offscreen, ~1px, or transparent
function isFillable(el) {
  if (!el.isConnected) return false;
  const s = getComputedStyle(el);

  // not rendered at all: legit hidden-then-revealed or manager-only field, allow
  if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return true;
  if (el.offsetParent === null && s.position !== "fixed") return true; // in a display:none ancestor

  // field IS laid out and "shown" - block the clickjacking patterns:
  const r = el.getBoundingClientRect();
  // tiny field hiding a real fill (1px trick)
  if (r.width < 4 || r.height < 4) return false;
  // transparent but occupying space (opacity:0 overlay)
  if (parseFloat(s.opacity) < 0.1) return false;
  // entirely offscreen, the classic left:-9999px exfil. visible field overlaps viewport
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
    // offscreen could be below the fold - only far-offscreen exfil coords are hostile
    if (r.left < -1000 || r.top < -1000 || r.left > vw + 5000) return false;
  }
  return true;
}

// fill near the anchor the user acted on so a multi-form page fills the RIGHT one.
// scope to the anchor's form when it has one, else nearest password to the anchor
function fillCredentials(username, password, anchor) {
  const inputs = Array.from(document.querySelectorAll("input")).filter(isFillable);
  let passwords = inputs.filter(isPasswordField);
  let usernames = inputs.filter(isUsernameField);

  const anchorForm = anchor && anchor.form;
  if (anchorForm) {
    const pwInForm = passwords.filter((p) => p.form === anchorForm);
    const userInForm = usernames.filter((u) => u.form === anchorForm);
    if (pwInForm.length) passwords = pwInForm;
    if (userInForm.length) usernames = userInForm;
  }

  // password in anchor's form, else nearest by doc position, else first
  let firstPw = passwords[0];
  if (anchor && passwords.length > 1) {
    firstPw = passwords
      .map((p) => ({ p, d: Math.abs(domDistance(anchor, p)) }))
      .sort((a, b) => a.d - b.d)[0].p;
  }

  // if the anchor itself is a username field, fill IT not some other form's
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
    filled = true;
  }
  return filled;
}

// rough DOM-order distance, for "nearest password"
function domDistance(a, b) {
  const all = Array.from(document.querySelectorAll("input"));
  return all.indexOf(a) - all.indexOf(b);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "fill") return false;
  // only accept fills from our own extension and only when host matches the origin
  // the background pinned the cred to, so a cred for site A never lands on site B
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, filled: false, error: "forbidden" });
    return true;
  }
  if (msg.expectedHost && location.hostname.toLowerCase() !== msg.expectedHost) {
    sendResponse({ ok: false, filled: false, error: "origin mismatch" });
    return true;
  }
  const filled = fillCredentials(msg.username, msg.password, fillAnchor);
  // remember what we filled so a submit right after doesnt re-offer to save this existing login
  if (filled) lastAutofill = { host: location.hostname, password: msg.password, at: Date.now() };
  if (filled && msg.notes && msg.notes.trim()) showFilledNote(msg.notes.trim(), fillAnchor);
  sendResponse({ ok: true, filled });
  return true;
});

// set when the user clicks an offer
let fillAnchor = null;
// last credential we autofilled, to suppress a save-offer for a login just filled from the vault
let lastAutofill = null;
// last password we generated, so its submit always offers to save (reset page / password change)
let lastGenerated = null;

// inline autofill suggestion: dropdown of saved logins on focus of a real login field.
// shown ONLY on genuine username/password fields (never OTP/search) so it cant recreate
// the balloon-on-every-box behavior
let suggestionEl = null;
let anchorField = null;
let cachedLogins = null; // null = not fetched yet, [] = fetched none
let navItems = []; // selectable dropdown rows: [{ el, onActivate }]
let navIndex = -1;
let filledNoteEl = null;
let filledNoteTimer = null;

function isLoginField(el) {
  if (!isVisible(el)) return false;

  if (isPasswordField(el)) return true;

  if (!isUsernameField(el)) return false;

  const form = el.form;
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();

  // explicit autocomplete=username is intentional, accept even when password lives
  // in a separate form (two-step / google-style logins)
  if (ac.includes("username")) return true;

  // a form opting out of autofill is a strong "not a login here" signal
  const formOptedOut = form && (form.getAttribute("autocomplete") || "").toLowerCase() === "off";
  if (formOptedOut) return false;

  // password in the SAME form => real login
  if (form && Array.from(form.querySelectorAll("input")).some(isPasswordField)) return true;

  // formless or password-not-in-this-form (SPA two-step, late password): only offer if a
  // visible password exists somewhere - evidence this is a login screen. without this the
  // old unconditional formless return fired on instagram tag boxes, search, newsletter
  if (pageHasVisiblePassword()) return true;

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
}

// show the entry's note by the field after a fill, dismiss on click
function showFilledNote(notes, field) {
  removeFilledNote();
  const anchor = field && field.getBoundingClientRect ? field : anchorField;
  const r =
    anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: 16, bottom: 16, width: 220 };
  const box = document.createElement("div");
  box.setAttribute("data-open-passwords", "note");
  Object.assign(box.style, {
    position: "absolute",
    zIndex: "2147483647",
    left: `${window.scrollX + r.left}px`,
    top: `${window.scrollY + r.bottom + 2}px`,
    maxWidth: "320px",
    background: "Canvas",
    color: "CanvasText",
    border: "1px solid rgba(128,128,128,0.4)",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    font: "12px -apple-system, system-ui, sans-serif",
    padding: "8px 10px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  });
  const head = document.createElement("div");
  head.textContent = "Note";
  Object.assign(head.style, { fontSize: "11px", opacity: "0.6", marginBottom: "4px" });
  const body = document.createElement("div");
  body.textContent = notes;
  box.append(head, body);
  box.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    removeFilledNote();
  });
  document.body.appendChild(box);
  filledNoteEl = box;
  clearTimeout(filledNoteTimer);
  filledNoteTimer = setTimeout(removeFilledNote, 12000);
}

function removeFilledNote() {
  if (filledNoteEl) {
    filledNoteEl.remove();
    filledNoteEl = null;
  }
  clearTimeout(filledNoteTimer);
}

// highlight active row, keep it in view
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

// make a row selectable by mouse and keyboard, tagged as a listbox option
function registerRow(row, onActivate) {
  row.setAttribute("role", "option");
  const idx = navItems.length;
  navItems.push({ el: row, onActivate });
  row.addEventListener("mouseenter", () => setActiveNav(idx));
  row.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return; // ignore page-synthesized events
    e.preventDefault();
    onActivate();
  });
}

// arrows move selection, Enter fills the row (not submit), Escape closes. driven from the
// focused anchor field (rows use mousedown+preventDefault so they never steal focus)
function onSuggestionKeydown(e) {
  if (!e.isTrusted) return; // a synthesized Enter must never select+fill a credential
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

// re-position under the anchor on build and on scroll/resize so the dropdown follows
// the field instead of being destroyed
function positionBox() {
  if (!suggestionEl || !anchorField) return;
  // field gone or hidden (SPA step change, goes away after submit) - dont leave it dangling
  if (!anchorField.isConnected || !isVisible(anchorField)) {
    removeSuggestion();
    return;
  }
  const r = anchorField.getBoundingClientRect();
  suggestionEl.style.left = `${window.scrollX + r.left}px`;
  suggestionEl.style.top = `${window.scrollY + r.bottom + 2}px`;
  suggestionEl.style.minWidth = `${Math.max(r.width, 200)}px`;
}

function buildSuggestionBox(field) {
  removeSuggestion();
  anchorField = field;
  const box = document.createElement("div");
  box.setAttribute("data-open-passwords", "suggestions");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", "Open Passwords suggestions");
  Object.assign(box.style, {
    position: "absolute",
    zIndex: "2147483647",
    background: "Canvas",
    color: "CanvasText",
    border: "1px solid rgba(128,128,128,0.4)",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
    font: "13px -apple-system, system-ui, sans-serif",
    overflow: "hidden",
  });
  const header = document.createElement("div");
  header.textContent = "Open Passwords";
  Object.assign(header.style, {
    padding: "6px 10px",
    fontSize: "11px",
    opacity: "0.6",
    borderBottom: "1px solid rgba(128,128,128,0.2)",
  });
  box.appendChild(header);
  document.body.appendChild(box);
  suggestionEl = box;
  positionBox();
  return box;
}

// locked: PIN field in the dropdown so the user can unlock without leaving the page.
// background issues a challenge (macos shows the 6-digit code), then verify inline
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
    margin: "4px 10px 6px",
    width: "calc(100% - 20px)",
    padding: "8px",
    fontSize: "16px",
    letterSpacing: "4px",
    textAlign: "center",
    border: "1px solid rgba(128,128,128,0.4)",
    borderRadius: "6px",
    background: "Canvas",
    color: "CanvasText",
    boxSizing: "border-box",
  });
  box.appendChild(input);

  const status = document.createElement("div");
  Object.assign(status.style, { padding: "0 10px 8px", fontSize: "12px", color: "#ff453a", minHeight: "14px" });
  box.appendChild(status);

  // keep the dropdown open while interacting with the PIN field
  input.addEventListener("mousedown", (e) => e.stopPropagation());

  const setStatus = (text, isError) => {
    status.style.color = isError ? "#ff453a" : "rgba(128,128,128,0.9)";
    status.textContent = text;
  };

  // trigger a challenge so the mac shows a code. verifyPin also ensures one exists, no race
  chrome.runtime.sendMessage({ type: "requestChallenge" }).catch(() => {});

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
      // caller wants to resume its own action after unlock (e.g. save the password)
      if (typeof onUnlock === "function") {
        removeSuggestion();
        onUnlock();
        return;
      }
      // unlocked: complete the autofill they already asked for - fill directly on a
      // single match, else show the chooser
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
    } else {
      // wrong PIN: clear and retry. background re-issues a fresh challenge on next verify
      setStatus(res?.error || "Incorrect code, try again", true);
      input.value = "";
      input.focus();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return; // ignore page-synthesized events
    if (e.key === "Enter") doVerify();
  });
  // auto-submit as soon as all 6 digits are in, like apple - no Enter needed
  input.addEventListener("input", () => {
    if (input.value.trim().length === 6) doVerify();
  });

  setTimeout(() => input.focus(), 0);
}

// a password field the user is creating (not signing in with): explicit new-password, or a
// signup shape - a confirm field present, or a register-style submit on the page
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

// crypto-random integer in [0, n)
function randBelow(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}
function pickFrom(set) {
  return set[randBelow(set.length)];
}

// apple's "Strong Password" format (per rmondello, who built Apple Passwords): 20 chars =
// three CVCCVC syllable groups hyphenated = 16 lowercase + 1 uppercase + 1 digit + 2 hyphens.
// 19 consonants, 6 vowels; the digit goes in one of 5 slots (either side of a hyphen, or end)
function generateApplePassword() {
  const C = "bcdfghjkmnpqrstvwxz"; // 19 consonants (no ambiguous 'l')
  const V = "aeiouy"; // 6 vowels
  const groups = [];
  for (let g = 0; g < 3; g++) {
    groups.push([pickFrom(C), pickFrom(V), pickFrom(C), pickFrom(C), pickFrom(V), pickFrom(C)]); // CVCCVC
  }
  // digit into a boundary consonant slot: end of g0, both ends of g1, start of g2, end of g2
  // ("either side of a hyphen, or the end")
  const digitSlots = [[0, 5], [1, 0], [1, 5], [2, 0], [2, 5]];
  const [dg, dp] = digitSlots[randBelow(digitSlots.length)];
  groups[dg][dp] = String(randBelow(10));
  // uppercase one letter, any position that isnt the digit
  let ug, up;
  do {
    ug = randBelow(3);
    up = randBelow(6);
  } while (ug === dg && up === dp);
  groups[ug][up] = groups[ug][up].toUpperCase();
  return groups.map((g) => g.join("")).join("-");
}

// apple's "Without Special Characters" fallback (for sites that reject the hyphen): random
// alphanumeric with at least one of each class, 15 chars to match apple's own output
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

// fill a chosen generated password into the focused field and any empty confirm field in the
// same form. the submit save-flow then stores it (username + this password) in apple passwords
function fillGeneratedPassword(field, pw) {
  const targets = new Set([field]);
  for (const p of Array.from(document.querySelectorAll('input[type="password"]')).filter(isFillable)) {
    if (p === field || p.value) continue;
    if (p.form && field.form && p.form !== field.form) continue;
    targets.add(p);
  }
  for (const t of targets) setValue(t, pw);
  // remember we generated this so submit always offers to save it (reset page / password change)
  lastGenerated = { host: location.hostname, password: pw, at: Date.now() };
}

// one row per saved login, showing the username/email like chrome. fill routes through the
// origin-checked background path, page never sees the password
function appendLoginRows(box, field, logins) {
  for (const login of logins) {
    const row = document.createElement("div");
    row.textContent = login.username || "(no username)";
    Object.assign(row.style, {
      padding: "8px 10px",
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

// the two generator options (apple-style), each previewing the value it fills, below the
// saved accounts
function appendGeneratorOptions(box, field, separatorAbove) {
  const options = [
    { label: "Strong Password", value: generateApplePassword() },
    { label: "Without Special Characters", value: generateAlphanumericPassword() },
  ];
  options.forEach((opt, idx) => {
    const item = document.createElement("div");
    item.setAttribute("data-op-generate", "1");
    Object.assign(item.style, {
      padding: "8px 10px",
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

// saved accounts first (listing names is free, no Touch ID), then generator options on a
// new-password field. locked vault shows an unlock row
async function buildOfferSuggestion(field) {
  const box = buildSuggestionBox(field);
  const hasGenerator = isNewPasswordField(field);

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "inlineLogins" });
  } catch {
    res = null;
  }
  // the field may have been blurred and the box torn down (or rebuilt) while we awaited
  if (suggestionEl !== box) return;

  if (res?.ok && res.locked) {
    // cant list saved accounts while locked - offer to unlock, then the generator below
    const row = document.createElement("div");
    row.textContent = "Unlock to autofill…";
    Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
    registerRow(row, () => buildLockedSuggestion(field));
    box.appendChild(row);
    if (hasGenerator) appendGeneratorOptions(box, field, true);
    return;
  }

  const logins = res?.ok ? res.logins || [] : [];
  if (logins.length) appendLoginRows(box, field, logins);
  if (hasGenerator) appendGeneratorOptions(box, field, logins.length > 0);
  if (!logins.length && !hasGenerator) removeSuggestion();
}

// post-unlock chooser reuses the same row list
function buildChooser(field, logins) {
  if (!logins.length) {
    removeSuggestion();
    return;
  }
  const box = buildSuggestionBox(field);
  appendLoginRows(box, field, logins);
}

// IdP/CIAM/SSO/payment/bank-aggregation domains that legitimately host login UIs in
// cross-origin iframes, matched by registrable domain. EXCLUDES generic app/static hosting
// where anyone can deploy under a subdomain (firebaseapp.com, web.app, supabase.co,
// github.io, myshopify.com, *.vercel/netlify/pages.dev) and bare token hosts like
// windows.net. each allowed frame is keyed to its OWN origin in the background - it only
// ever sees creds for that exact provider origin, never the top page's
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

// host is or is a subdomain of an allowlisted domain. suffix match (not last-2-labels)
// so "clerk.accounts.dev" matches without ever matching a bare "accounts.dev"
function isAllowlistedLoginHost(host) {
  host = host.toLowerCase();
  return IFRAME_LOGIN_ALLOWLIST.some((d) => host === d || host.endsWith("." + d));
}

// we run in iframes too (all_frames). offer in a frame only when (a) same-origin with the
// top page or (b) a known IdP/SSO/payment login host. unknown cross-origin frames
// (ads/trackers) refused, matching chrome's "fill embedded logins not arbitrary frames"
function frameIsSafe() {
  if (window === window.top) return true; // top frame always fine
  if (isAllowlistedLoginHost(location.hostname)) return true;
  try {
    return location.origin === window.top.location.origin;
  } catch {
    return false; // unknown cross-origin frame -> dont offer
  }
}

async function onFocusIn(e) {
  const field = e.target;
  if (!(field instanceof HTMLInputElement) || !isLoginField(field)) {
    return;
  }
  if (!frameIsSafe()) return; // skip unrelated cross-origin iframes
  // dont offer on a field already filled/typed into
  if (field.value && field.value.trim() !== "") {
    removeSuggestion();
    return;
  }
  // neutral offer only - dont fetch logins or reveal anything yet. lock state checked
  // lazily on click so we dont hit the helper on every focus
  buildOfferSuggestion(field);
}

document.addEventListener("focusin", onFocusIn, true);
// arrow/Enter/Escape navigation for the dropdown. capture so we can intercept Enter before
// the page's own submit handling
document.addEventListener("keydown", onSuggestionKeydown, true);
// follow the field on scroll/resize. focusing auto-scrolls it into view, which previously
// fired this and killed the offer - the "click away then back and its gone" bug
document.addEventListener("scroll", positionBox, true);
window.addEventListener("resize", positionBox, true);
// dismiss when the field blurs to anything outside the dropdown. focus moving INTO the box
// (the inline PIN field) is kept
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
    // clicking ANOTHER login field: dont close here, its own focusin rebuilds the offer.
    // closing now (mousedown before focusin) would race and leave it with no dropdown
    if (e.target instanceof HTMLInputElement && isLoginField(e.target)) return;
    removeSuggestion();
  },
  true,
);

// --- save / update -------------------------------------------------------------
// offer to store credentials the user submits, like chrome/safari "save password?".
// we forward the submitted username+password to the helper, which decides add-vs-update
// and shows the native macOS prompt - nothing is written without the user confirming
// there. fires only on genuine (isTrusted) user submits
let lastSaveKey = "";
let lastSaveAt = 0;

// treat a control as a submit if it is type=submit, or a button whose label reads like
// a sign-in / sign-up / save action (covers SPA logins with no real <form> submit)
const SUBMITY_LABEL =
  /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|change[\s-]?password|continue|next|submit)\b/i;

function isSubmitControl(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  if ((tag === "button" || tag === "input") && type === "submit") return true;
  if (tag === "button" && (type === "" || type === "button")) {
    return SUBMITY_LABEL.test((el.textContent || el.value || attrBlob(el)) ?? "");
  }
  return false;
}

// pick the credential the user submitted within a scope. the "new" password on a
// change/confirm form is the last password field with a value; the username is the
// login field just before the first password
function collectSubmittedCredentials(scope) {
  const root = scope && scope.querySelectorAll ? scope : document;
  const inputs = Array.from(root.querySelectorAll("input"));
  const pws = inputs.filter((i) => isPasswordField(i) && i.value);
  if (!pws.length) return null;
  const password = pws[pws.length - 1].value;
  const firstPw = pws[0];
  // field sits before the (first) password in document order
  const before = (el) => el.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING;

  // preferred: a real username/email field that precedes the password
  const strict = inputs.filter((i) => isUsernameField(i) && i.value);
  const strictBefore = strict.filter(before);
  let userEl = strictBefore.length ? strictBefore[strictBefore.length - 1] : strict[0] || null;

  // fallback: no strict match (bare box, no autocomplete). nearest filled text/email/tel field
  // before the password is the username, but reject junk so a reset doesnt save "9" as the name
  if (!userEl) {
    const looksLikeUsername = (v) => {
      v = (v || "").trim();
      if (v.length < 3) return false;
      if (/^\d+$/.test(v) && v.length < 6) return false; // a short number is a code, not a name
      return true;
    };
    const guess = inputs.filter((i) => {
      if (!i.value || isPasswordField(i)) return false;
      if (isOtpField(i) || isSearchOrComboField(i)) return false;
      const t = (i.type || "text").toLowerCase();
      if (!["text", "email", "tel", ""].includes(t)) return false;
      if (NONLOGIN_HINT.test(attrBlob(i))) return false;
      if (!looksLikeUsername(i.value)) return false;
      return before(i);
    });
    userEl = guess.length ? guess[guess.length - 1] : null;
  }

  // allPasswords: a change form's last field is often the current/old password, so the caller
  // can spot a generated value that isnt last
  return { username: (userEl?.value || "").trim(), password, allPasswords: pws.map((p) => p.value) };
}

function anchorPwField(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const pws = Array.from(scope.querySelectorAll('input[type="password"]'));
  return pws.find(isVisible) || pws[0] || null;
}

// send the save to the helper. if the vault turns out locked, surface the PIN then retry
function sendSave(username, password, field) {
  console.debug("[Open Passwords] sending save", { user: username || "(none)" });
  chrome.runtime
    .sendMessage({ type: "maybeSave", username, password })
    .then((res) => {
      if (res?.ok && res.locked && field) {
        buildLockedSuggestion(field, () =>
          chrome.runtime.sendMessage({ type: "maybeSave", username, password }).catch(() => {}),
        );
      }
    })
    .catch(() => {});
}

// reset/change with no matching username: show the site's saved accounts so the new password
// updates the right one. single account skips the chooser (handled by the caller)
function showSaveAccountChooser(existing, detected, password, field) {
  const anchor = field || anchorPwField(document);
  if (!anchor) return sendSave(existing[0], password, null);
  const box = buildSuggestionBox(anchor);
  const title = document.createElement("div");
  title.textContent = "Save password for";
  Object.assign(title.style, { padding: "8px 10px 4px", fontSize: "12px", opacity: "0.8" });
  box.appendChild(title);
  for (const u of existing) {
    const row = document.createElement("div");
    row.textContent = u;
    Object.assign(row.style, {
      padding: "8px 10px",
      cursor: "pointer",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    registerRow(row, () => {
      removeSuggestion();
      sendSave(u, password, anchor);
    });
    box.appendChild(row);
  }
  const nw = document.createElement("div");
  nw.textContent = detected ? `New account: ${detected}` : "Save as new account";
  Object.assign(nw.style, {
    padding: "8px 10px",
    cursor: "pointer",
    borderTop: "1px solid rgba(128,128,128,0.2)",
    opacity: "0.85",
  });
  registerRow(nw, () => {
    removeSuggestion();
    sendSave(detected, password, anchor);
  });
  box.appendChild(nw);
}

// decide who to save the submitted password for. key case: a reset/change with no usable
// username where the vault already has account(s) - attach it to an existing one, not a dupe
async function maybeOfferSave(scope) {
  if (!frameIsSafe()) return;
  const cred = collectSubmittedCredentials(scope);
  if (!cred || !cred.password) return;

  // generated if the value we generated is present in ANY submitted password field (a change
  // form's last field is often the current/old password). unique + recent, so no host match
  const genPw =
    lastGenerated && Date.now() - lastGenerated.at < 600000 ? lastGenerated.password : null;
  const generated = !!genPw && (cred.allPasswords || []).includes(genPw);
  const savePassword = generated ? genPw : cred.password;

  // a login we just autofilled unchanged is not a save (unless we generated a new password)
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

  // dedupe, claimed synchronously before any await ("shows up twice" fix)
  const key = `${location.hostname} ${cred.username || savePassword}`;
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 60000) return;
  lastSaveKey = key;
  lastSaveAt = now;

  const root = scope && scope.querySelectorAll ? scope : document;
  const pwInputs = Array.from(root.querySelectorAll('input[type="password"]'));
  const field = pwInputs.find(isVisible) || pwInputs[0] || null;
  // create/change context vs a plain login (two+ password fields, new-password, or generated)
  const newPwCtx =
    generated ||
    (cred.allPasswords || []).length >= 2 ||
    pwInputs.some((p) => (p.getAttribute("autocomplete") || "").toLowerCase().includes("new-password"));

  // accounts already saved for this site (names only, free, no Touch ID)
  let existing = [];
  let locked = false;
  try {
    const r = await chrome.runtime.sendMessage({ type: "inlineLogins" });
    if (r?.ok) {
      locked = !!r.locked;
      existing = (r.logins || []).map((l) => l.username).filter(Boolean);
    }
  } catch {}

  const detected = cred.username;
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());

  console.debug("[Open Passwords] save-check", {
    host: location.hostname,
    user: detected || "(none)",
    pwFields: (cred.allPasswords || []).length,
    generated,
    newPwCtx,
    existingCount: existing.length,
    matched: !!matched,
    locked,
  });

  // 1) page username matches a saved account
  if (matched) {
    if (generated) return sendSave(matched, savePassword, field); // password change -> update it
    console.debug("[Open Passwords] save skipped: existing account, no new password");
    return; // plain re-login, dont nag
  }

  // 2) page gave a real, unmatched username -> a new account (signup / new login). offer it
  if (detected) return sendSave(detected, savePassword, field);

  // 3) no username, reset/change on a site with saved account(s): surface them to update one
  if (newPwCtx && !locked && existing.length) {
    if (existing.length === 1) return sendSave(existing[0], savePassword, field);
    return showSaveAccountChooser(existing, detected, savePassword, field);
  }

  // 4) otherwise only a generated password proceeds (native sheet asks for the username)
  if (generated) return sendSave(detected, savePassword, field);
  console.debug("[Open Passwords] save skipped: no username");
}

document.addEventListener(
  "submit",
  (e) => {
    if (!e.isTrusted) return;
    removeSuggestion(); // the autofill dropdown must not outlive the submit
    maybeOfferSave(e.target);
  },
  true,
);
document.addEventListener(
  "click",
  (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const ctrl = e.target.closest("button, input[type=submit], input[type=button]");
    if (isSubmitControl(ctrl)) maybeOfferSave(ctrl.form || document);
  },
  true,
);
// Enter inside a login field on a formless (SPA) login
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted || e.key !== "Enter") return;
    const t = e.target;
    if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) {
      removeSuggestion(); // formless (SPA) submit: Enter doesnt fire a submit event
      maybeOfferSave(t.form || document);
    }
  },
  true,
);
