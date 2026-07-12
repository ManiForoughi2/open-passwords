// owns the native connection + SRP session, brokers popup/content-script requests.
// alarm keep-alive holds the MV3 worker (and in-memory session key) alive so the
// user isnt re-prompted for the PIN on every idle-out

import { ApplePasswords, State } from "./protocol.js";

const client = new ApplePasswords();

client.onStateChange((s) => {
  // any state other than unlocked means the session/keys are gone - drop the plaintext cache
  if (s !== State.Unlocked) pwCacheClear();
  broadcast({ type: "state", state: s });
});

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// most-recently-used login per host (in-memory), so the dropdown floats your usual account up
const mruByHost = new Map(); // host -> [username lowercased, most recent first]
function recordMru(host, username) {
  if (!host || !username) return;
  const u = username.toLowerCase();
  const arr = (mruByHost.get(host) || []).filter((x) => x !== u);
  arr.unshift(u);
  mruByHost.set(host, arr.slice(0, 10));
}
function orderByMru(host, logins) {
  const order = mruByHost.get(host);
  if (!order || !order.length) return logins;
  const rank = (u) => {
    const i = order.indexOf((u || "").toLowerCase());
    return i === -1 ? Infinity : i;
  };
  // stable sort keeps the helper's own order for anything not in the MRU list
  return [...logins].sort((a, b) => rank(a.username) - rank(b.username));
}

// short-lived cache of decrypted passwords so re-filling the same login skips a second Touch
// ID (apple prompts every read). plaintext in worker memory up to the TTL, cleared on lock
const PW_CACHE_TTL_MS = 120_000; // 2 minutes
const pwCache = new Map(); // `${host}\n${username lowercased}` -> { cred, at }
function pwCacheKey(host, username) {
  return `${host}\n${(username || "").toLowerCase()}`;
}
function pwCacheGet(host, username) {
  const k = pwCacheKey(host, username);
  const hit = pwCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > PW_CACHE_TTL_MS) {
    pwCache.delete(k);
    return null;
  }
  return hit.cred;
}
function pwCacheSet(host, cred) {
  if (!host || !cred?.username) return;
  pwCache.set(pwCacheKey(host, cred.username), { cred, at: Date.now() });
}
function pwCacheClear() {
  pwCache.clear();
}

// stuck native call shouldnt leave a UI waiter (inline PIN box) hanging forever
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || "timed out")), ms)),
  ]);
}

// defeat the MV3 ~30s idle shutdown that kills the session
const KEEPALIVE_ALARM = "open-passwords-keepalive";
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  // touching an extension API resets the idle timer
  chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
});

async function ensureConnected() {
  if (client.state === State.Disconnected) {
    try {
      await client.connect();
    } catch (e) {
      // surfaced via state change (NoHelper / Disconnected)
    }
  }
}

chrome.runtime.onStartup.addListener(ensureConnected);
chrome.runtime.onInstalled.addListener(ensureConnected);
ensureConnected();

// suppress only Chrome password autofill so it doesnt pop a competing dropdown.
// leave address and credit-card / Google Pay autofill alone (Apple's extension
// kills those too, a top complaint)
function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc) return;
  try {
    svc.passwordSavingEnabled?.set({ value: false }, () => void chrome.runtime.lastError);
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(suppressChromeAutofill);
chrome.runtime.onStartup.addListener(suppressChromeAutofill);
suppressChromeAutofill();

// only the extension's own popup/options pages may drive privileged actions.
// content-script messages carry sender.tab, the popup never does. gate that
// stops any web page from requesting or filling passwords
function isFromOwnUi(sender) {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

// resolve from the real active tab, never from caller input
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function registrableHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// loopback (secure context) and reserved .test / .localhost TLDs (RFC 6761, never real
// sites) are the only non-HTTPS origins we treat as fillable/saveable
function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host?.endsWith(".localhost") ||
    host?.endsWith(".test")
  );
}

// messages a content script may send. operate only on the sender's own tab/origin
// and never return a password to the page (inlineFill pushes straight to the fill
// handler, page script never sees it). verifyPin takes a PIN guess and returns lock
// state only, never vault data
const CONTENT_ALLOWED = new Set(["inlineLogins", "inlineFill", "requestChallenge", "verifyPin", "maybeSave"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // privileged actions are popup-only; content script gets the inline msgs only
      const fromUi = isFromOwnUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab !== undefined;
      if (!fromUi && !(fromContent && CONTENT_ALLOWED.has(msg?.type))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg?.type) {
        case "inlineLogins": {
          // login names only (no passwords) for the exact frame that asked. origin
          // is sender.url, never the top tab's, so a sub-frame cant enumerate the
          // top page's usernames
          const frameUrl = sender.url;
          if (!frameUrl) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: true, locked: true, logins: [] });
          try {
            const logins = await client.getLoginNamesForURL(sender.tab?.id, frameUrl);
            sendResponse({ ok: true, locked: false, logins: orderByMru(registrableHost(frameUrl), logins) });
          } catch {
            sendResponse({ ok: true, locked: false, logins: [] });
          }
          break;
        }

        case "inlineFill": {
          // fetch password for the requesting frame's own origin, deliver fill to
          // that one frame only (frameId), never broadcast. confused-deputy fix: a
          // sub-frame cant pull the top page's password nor grab another frame's fill
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = registrableHost(frameUrl);
          const isLocalDev =
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "[::1]" ||
            host?.endsWith(".localhost") ||
            host?.endsWith(".test");
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDev) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          // ignore caller-supplied loginName.sites, query by frame's own host
          // (handled in protocol.js); pass only username through
          const safeLogin = { username: msg.loginName?.username };
          // cache hit skips the helper read and its Touch ID; miss reads then caches
          let cred = pwCacheGet(host, safeLogin.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(sender.tab.id, frameUrl, safeLogin);
            if (cred) pwCacheSet(host, cred);
          }
          let filled = false;
          if (cred) {
            const resp = await chrome.tabs.sendMessage(
              sender.tab.id,
              {
                type: "fill",
                username: cred.username,
                password: cred.password,
                notes: cred.notes,
                expectedHost: host,
              },
              { frameId }, // requesting frame only
            );
            filled = !!resp?.filled;
            if (filled) recordMru(host, cred.username);
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "maybeSave": {
          // a content script offering credentials the user just submitted. the native
          // macOS prompt is the real gate (nothing is written to the vault without the
          // user confirming there), so we only forward. pin to the sender frame's own
          // origin, never the top tab's
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to save from a non-HTTPS frame" });
          }
          if (!msg.password) return sendResponse({ ok: false, error: "no password" });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: true, saved: false, locked: true });
          await client.saveLogin(sender.tab.id, frameUrl, msg.username ?? "", msg.password);
          sendResponse({ ok: true, saved: true });
          break;
        }

        case "getState":
          await ensureConnected();
          sendResponse({ ok: true, state: client.state });
          break;

        case "connect":
          await ensureConnected();
          sendResponse({ ok: true, state: client.state });
          break;

        case "requestChallenge":
          // top frame (or popup) only, so a hostile sub-frame cant spam native prompts
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await ensureConnected();
          await withTimeout(client.requestChallenge(), 8000, "challenge timed out");
          sendResponse({ ok: true, state: client.state });
          break;

        case "verifyPin":
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          // cap so a non-responding helper cant leave the inline PIN box stuck
          await withTimeout(client.verifyPin(msg.pin), 8000, "verification timed out");
          sendResponse({ ok: true, state: client.state });
          break;

        case "getLogins": {
          // real active tab's URL, never caller-supplied
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const logins = await client.getLoginNamesForURL(tab.id, tab.url);
          sendResponse({ ok: true, logins: orderByMru(registrableHost(tab.url), logins) });
          break;
        }

        case "fillOnPage": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const host = registrableHost(tab.url);
          // require HTTPS except local dev: loopback (secure context) and reserved
          // .test / .localhost TLDs (RFC 6761, never real sites)
          const isLocalDev =
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "[::1]" ||
            host?.endsWith(".localhost") ||
            host?.endsWith(".test");
          if (!/^https:\/\//i.test(tab.url) && !isLocalDev) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          let cred = pwCacheGet(host, msg.loginName?.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(tab.id, tab.url, msg.loginName);
            if (cred) pwCacheSet(host, cred);
          }
          let filled = false;
          if (cred) {
            // content script re-checks expectedHost before filling
            const resp = await chrome.tabs.sendMessage(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              notes: cred.notes,
              expectedHost: host,
            });
            filled = !!resp?.filled;
            if (filled) recordMru(host, cred.username);
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "clearCache":
          // popup refresh: drop cached passwords so the next fill re-reads a just-changed one
          pwCacheClear();
          sendResponse({ ok: true });
          break;

        case "disconnect":
          client.disconnect();
          sendResponse({ ok: true, state: client.state });
          break;

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e), state: client.state });
    }
  })();
  return true; // async response
});
