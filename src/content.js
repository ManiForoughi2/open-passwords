// fills credentials into the page on request from popup. never treats OTP inputs
// as fillable login fields - that misclassification is apple's balloon-on-every-OTP bug
console.log("[Open Passwords] content script v0.13.0 loaded");

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
  // require a login-specific token, bare email/account substrings are too broad
  return /\b(user(name)?|login|signin|sign[\s-]?in|userid|loginid)\b/i.test(blob);
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
  sendResponse({ ok: true, filled });
  return true;
});

// set when the user clicks an offer
let fillAnchor = null;

// inline autofill suggestion: dropdown of saved logins on focus of a real login field.
// shown ONLY on genuine username/password fields (never OTP/search) so it cant recreate
// the balloon-on-every-box behavior
let suggestionEl = null;
let anchorField = null;
let cachedLogins = null; // null = not fetched yet, [] = fetched none

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
}

// re-position under the anchor on build and on scroll/resize so the dropdown follows
// the field instead of being destroyed
function positionBox() {
  if (!suggestionEl || !anchorField) return;
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
  input.addEventListener("keydown", async (e) => {
    if (!e.isTrusted) return; // ignore page-synthesized events
    if (e.key !== "Enter") return;
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
  });

  setTimeout(() => input.focus(), 0);
}

// step 1: neutral "click to autofill" prompt, no username revealed until they ask.
// clicking fetches logins and shows the chooser (step 2)
function buildOfferSuggestion(field) {
  const box = buildSuggestionBox(field);
  const row = document.createElement("div");
  row.textContent = "Click to autofill";
  Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
  row.addEventListener("mouseenter", () => (row.style.background = "rgba(10,132,255,0.15)"));
  row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
  row.addEventListener("mousedown", async (e) => {
    if (!e.isTrusted) return; // ignore page-synthesized events
    e.preventDefault();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "inlineLogins" });
    } catch {
      return;
    }
    if (!res?.ok) return;
    if (res.locked) return buildLockedSuggestion(field);
    const logins = res.logins || [];
    if (logins.length === 1) {
      removeSuggestion();
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: logins[0] });
    } else {
      buildChooser(field, logins);
    }
  });
  box.appendChild(row);
}

// step 2: username chooser, only after they click and there's more than one login
function buildChooser(field, logins) {
  if (!logins.length) {
    removeSuggestion();
    return;
  }
  const box = buildSuggestionBox(field);
  for (const login of logins) {
    const row = document.createElement("div");
    row.textContent = login.username || "(no username)";
    Object.assign(row.style, { padding: "8px 10px", cursor: "pointer" });
    row.addEventListener("mouseenter", () => (row.style.background = "rgba(10,132,255,0.15)"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
    row.addEventListener("mousedown", (e) => {
      if (!e.isTrusted) return; // ignore page-synthesized events
      e.preventDefault();
      removeSuggestion();
      fillAnchor = field;
      chrome.runtime.sendMessage({ type: "inlineFill", loginName: login });
    });
    box.appendChild(row);
  }
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
// follow the field on scroll/resize. focusing auto-scrolls it into view, which previously
// fired this and killed the offer - the "click away then back and its gone" bug
document.addEventListener("scroll", positionBox, true);
window.addEventListener("resize", positionBox, true);
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
  const users = inputs.filter((i) => isUsernameField(i) && i.value);
  let username = "";
  if (users.length) {
    const before = users.filter(
      (u) => u.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    username = (before.length ? before[before.length - 1] : users[0]).value;
  }
  return { username: username.trim(), password };
}

async function maybeOfferSave(scope) {
  if (!frameIsSafe()) return;
  const cred = collectSubmittedCredentials(scope);
  if (!cred || !cred.password) return;
  // a submit often fires both a click and a submit event - dedupe identical creds
  const key = `${location.hostname} ${cred.username} ${cred.password}`;
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 5000) return;
  lastSaveKey = key;
  lastSaveAt = now;

  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "maybeSave",
      username: cred.username,
      password: cred.password,
    });
  } catch {
    return;
  }
  if (res?.ok && res.locked) {
    // locked at submit time: let the user unlock inline, then save. anchor on the
    // password field theyre using so the box appears in a sensible spot
    const field =
      document.activeElement instanceof HTMLInputElement && isPasswordField(document.activeElement)
        ? document.activeElement
        : Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (field) {
      buildLockedSuggestion(field, () =>
        chrome.runtime
          .sendMessage({ type: "maybeSave", username: cred.username, password: cred.password })
          .catch(() => {}),
      );
    }
  }
}

document.addEventListener(
  "submit",
  (e) => {
    if (e.isTrusted) maybeOfferSave(e.target);
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
      maybeOfferSave(t.form || document);
    }
  },
  true,
);
