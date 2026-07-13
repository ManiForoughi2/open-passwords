// owns the native connection + SRP session; alarm keep-alive holds the MV3 worker so the PIN isnt re-prompted every idle-out

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

// which account a submitted password attaches to ("" lets the native sheet ask, null saves nothing); in the background so a redirect cant lose it
function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (detected) return detected;
  // no username on a reset with saved account(s): attach to the MRU one, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) {
    return orderByMru(host, existing.map((u) => ({ username: u })))[0].username;
  }
  if (generated) return "";
  return null;
}

// new-password saves that arrived while locked; a reset can navigate away, so stash and flush on unlock
const pendingSaves = [];
function queuePendingSave(save) {
  const k = `${save.host} ${(save.detected || "").toLowerCase()}`;
  const i = pendingSaves.findIndex((p) => `${p.host} ${(p.detected || "").toLowerCase()}` === k);
  if (i >= 0) pendingSaves.splice(i, 1); // newest wins
  pendingSaves.push(save);
  while (pendingSaves.length > 10) pendingSaves.shift();
}
async function flushPendingSaves() {
  if (!client.ready || !pendingSaves.length) return;
  const batch = pendingSaves.splice(0);
  for (const s of batch) {
    try {
      let existing = [];
      try {
        existing = (await client.getLoginNamesForURL(s.tabId, s.frameUrl))
          .map((l) => l.username)
          .filter(Boolean);
      } catch {}
      const target = pickSaveTarget({ ...s, existing });
      if (target === null) continue;
      await client.saveLogin(s.tabId, s.frameUrl, target, s.password);
    } catch {}
  }
}

// collapse identical-looking usernames: trailing/leading space, zero-width chars, case, and
// unicode composition all equal. keeps internal spaces so distinct usernames arent merged
function normUsername(u) {
  return (u || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

// helper returns the same username several times (www + apex entries, or a stray-space dupe).
// fills look up by username, so extra rows only ever fetch the same credential - drop them
function uniqueByUsername(logins) {
  const seen = new Set();
  return logins.filter((l) => {
    const k = normUsername(l.username);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// what we last filled per tab, so a popup refresh can re-fill the page with a fresh read
const lastFillByTab = new Map(); // tabId -> { host, username }

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

// suppress only chrome password autofill, leave address + credit-card/google pay alone
function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc?.passwordSavingEnabled) return;
  // user-togglable from the popup, persisted choices. save bubble defaults on, address
  // autofill defaults off (credit-card autofill is never touched, google pay keeps working)
  chrome.storage?.local?.get({ suppressSaveBubble: true, suppressAddressAutofill: false }, (o) => {
    if (chrome.runtime.lastError) return;
    try {
      if (o.suppressSaveBubble) {
        svc.passwordSavingEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      }
      if (o.suppressAddressAutofill && svc.autofillAddressEnabled) {
        svc.autofillAddressEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      }
    } catch (_) {}
  });
}
chrome.runtime.onInstalled.addListener(suppressChromeAutofill);
chrome.runtime.onStartup.addListener(suppressChromeAutofill);
suppressChromeAutofill();

// only the extension's own popup may drive privileged actions (content messages carry sender.tab, the popup never does)
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

// messages a content script may send - only the sender's own tab/origin, never return a password to the page
const CONTENT_ALLOWED = new Set(["inlineLogins", "inlineFill", "requestChallenge", "verifyPin", "resolveSave"]);

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
          // login names only (no passwords) for the exact frame that asked, keyed to sender.url not the top tab
          const frameUrl = sender.url;
          if (!frameUrl) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: true, locked: true, logins: [] });
          try {
            const logins = await client.getLoginNamesForURL(sender.tab?.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              logins: uniqueByUsername(orderByMru(registrableHost(frameUrl), logins)),
            });
          } catch {
            sendResponse({ ok: true, locked: false, logins: [] });
          }
          break;
        }

        case "inlineFill": {
          // fetch + fill for the requesting frame's own origin only (frameId), never broadcast - confused-deputy fix
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
            if (filled) {
              recordMru(host, cred.username);
              lastFillByTab.set(sender.tab.id, { host, username: cred.username });
            }
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "resolveSave": {
          // resolve + save here in the background so a submit that navigates cant kill it; native sheet is still the write gate
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to save from a non-HTTPS frame" });
          }
          if (!msg.password) return sendResponse({ ok: false, error: "no password" });
          const detected = (msg.username || "").trim();
          const generated = !!msg.generated;
          const newPwCtx = !!msg.newPwCtx;
          await ensureConnected();

          // locked: cant list or write - stash a new-password save for unlock, a plain re-login isnt worth deferring
          if (!client.ready) {
            if (generated || newPwCtx) {
              queuePendingSave({
                host,
                frameUrl,
                tabId: sender.tab.id,
                detected,
                password: msg.password,
                generated,
                newPwCtx,
              });
            }
            return sendResponse({ ok: true, saved: false, locked: true });
          }

          let existing = [];
          try {
            existing = (await client.getLoginNamesForURL(sender.tab.id, frameUrl))
              .map((l) => l.username)
              .filter(Boolean);
          } catch {}
          const target = pickSaveTarget({ host, existing, detected, generated, newPwCtx });
          console.debug("[Open Passwords] resolveSave", {
            host,
            detected: detected || "(none)",
            generated,
            newPwCtx,
            existingCount: existing.length,
            target: target === null ? "(skip)" : target || "(ask)",
          });
          if (target === null) return sendResponse({ ok: true, saved: false, skipped: true });
          await client.saveLogin(sender.tab.id, frameUrl, target, msg.password);
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
          // just unlocked - complete any saves stashed while locked
          if (client.ready) flushPendingSaves();
          break;

        case "getLogins": {
          // real active tab's URL, never caller-supplied
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const logins = await client.getLoginNamesForURL(tab.id, tab.url);
          sendResponse({ ok: true, logins: uniqueByUsername(orderByMru(registrableHost(tab.url), logins)) });
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
            if (filled) {
              recordMru(host, cred.username);
              lastFillByTab.set(tab.id, { host, username: cred.username });
            }
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "refreshAndRefill": {
          // drop cache then re-fill the tab's last-filled login with a fresh read, so a
          // password changed in the Passwords app lands without re-clicking Fill
          pwCacheClear();
          const tab = await activeTab();
          const entry = tab?.id != null ? lastFillByTab.get(tab.id) : null;
          const host = tab?.url ? registrableHost(tab.url) : null;
          if (!entry || !host || entry.host !== host) {
            return sendResponse({ ok: true, refilled: false });
          }
          try {
            const cred = await client.getPasswordForLoginName(tab.id, tab.url, { username: entry.username });
            if (!cred) return sendResponse({ ok: true, refilled: false });
            pwCacheSet(host, cred);
            const resp = await chrome.tabs.sendMessage(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              notes: cred.notes,
              expectedHost: host,
            });
            sendResponse({ ok: true, refilled: !!resp?.filled, username: cred.username });
          } catch (e) {
            sendResponse({ ok: true, refilled: false, error: String(e?.message ?? e) });
          }
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
