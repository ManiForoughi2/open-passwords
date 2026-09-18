// alarm keep-alive holds the MV3 worker so the PIN isnt re-prompted every idle-out

import { ApplePasswords, State } from "./protocol.js";

const client = new ApplePasswords();

client.onStateChange((s) => {
  if (s !== State.Unlocked) {
    pwCacheClear();
    otpByTab.clear();
  }
  broadcast({ type: "state", state: s });
});

// one attempt per challenge, never a retry loop, a wrong read burns the code. only when the
// user asks for a code (popup, unlock click), never at browser launch
const AUTOPAIR_HOST = "com.openpasswords.autopair";
let autoPairBusy = false;
let autoPairError = null;

function autoPairEnabled() {
  return new Promise((r) => chrome.storage.local.get({ autoPair: false }, (o) => r(!!o.autoPair)));
}

function autoPairMsg(body) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(AUTOPAIR_HOST, body, (r) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : r || { ok: false, error: "no reply" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message ?? e) });
    }
  });
}

async function tryAutoPair(reason) {
  if (autoPairBusy || client.state !== State.NeedsPin) return false;
  if (!(await autoPairEnabled())) return false;
  autoPairBusy = true;
  try {
    // reuse a code already on screen rather than replacing it under the user
    await withTimeout(client.requestChallenge({ ifNeeded: true }), 8000, "challenge timed out");
    const res = await autoPairMsg({ action: "read", timeoutMs: 6000 });
    if (!res.ok || !res.code) {
      autoPairError = res.error || "no code visible";
      console.debug("[Open Passwords] auto-pair skipped:", autoPairError, reason);
      return false;
    }
    await withTimeout(client.verifyPin(res.code), 8000, "verification timed out");
    autoPairError = null;
    if (client.ready) {
      flushPendingSaves();
      // only the active tab can have the inline PIN box open
      try {
        const tab = await activeTab();
        if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "unlocked" }).catch(() => {});
      } catch (_) {}
    }
    return client.ready;
  } catch (e) {
    autoPairError = String(e?.message ?? e);
    console.debug("[Open Passwords] auto-pair failed:", autoPairError, reason);
    return false;
  } finally {
    autoPairBusy = false;
  }
}

client.onOneTimeCodeAvailable(async () => {
  try {
    const tab = await activeTab();
    if (tab?.id == null) return;
    otpByTab.delete(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: "oneTimeCodeAvailable" }).catch(() => {});
  } catch (_) {}
});

// rows resolve by id so the page never chooses the username/domain
const otpByTab = new Map();
const OTP_LIST_TTL_MS = 120_000;

// apple walks the whole parent chain via webNavigation, the top URL covers a same-site iframe without another permission
function frameUrlsFor(sender) {
  const urls = [];
  for (const u of [sender.url, sender.tab?.url]) {
    if (u && /^https?:/i.test(u) && !urls.includes(u)) urls.push(u);
  }
  return urls;
}

// never the code itself at list time
function otpRow(e, i) {
  return { id: i, source: e.source, username: e.username, domain: e.domain };
}

async function listOneTimeCodes(tabId, frameId, frameUrls) {
  const { entries, requiresAuth } = await client.getOneTimeCodes(tabId, frameId, frameUrls);
  otpByTab.set(tabId, { at: Date.now(), entries, frameId, frameUrls });
  return { rows: entries.map(otpRow), requiresAuth };
}

// TOTP is re-read now, the value rotates and this read triggers Touch ID when the vault demands it
async function resolveOneTimeCode(tabId, id) {
  const cached = otpByTab.get(tabId);
  if (!cached || Date.now() - cached.at > OTP_LIST_TTL_MS) throw new Error("code list expired, focus the field again");
  const entry = cached.entries[id];
  if (!entry) throw new Error("unknown code");
  if (entry.source !== "totp") return entry.code;
  const fresh = await client.readOneTimeCode(tabId, cached.frameId, cached.frameUrls, entry.username);
  const match =
    fresh.find((e) => e.source === "totp" && e.username === entry.username && e.domain === entry.domain) ||
    fresh.find((e) => e.source === "totp");
  if (!match?.code) throw new Error("no code returned");
  return match.code;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

const mruByHost = new Map();
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
  return [...logins].sort((a, b) => rank(a.username) - rank(b.username));
}

// "" lets the native sheet ask, null saves nothing
function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (detected) return detected;
  // attach to the MRU account, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) {
    return orderByMru(host, existing.map((u) => ({ username: u })))[0].username;
  }
  if (generated) return "";
  return null;
}

// a reset can navigate away, so stash saves that arrived while locked and flush on unlock
const pendingSaves = [];
function queuePendingSave(save) {
  const k = `${save.host} ${(save.detected || "").toLowerCase()}`;
  const i = pendingSaves.findIndex((p) => `${p.host} ${(p.detected || "").toLowerCase()}` === k);
  if (i >= 0) pendingSaves.splice(i, 1);
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

// keeps internal spaces so distinct usernames arent merged
function normUsername(u) {
  return (u || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

// helper returns the same username for www + apex entries, fills look up by username so dupes are useless
function uniqueByUsername(logins) {
  const seen = new Set();
  return logins.filter((l) => {
    const k = normUsername(l.username);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const lastFillByTab = new Map();

// re-filling the same login skips a second Touch ID, apple prompts every read
const PW_CACHE_TTL_MS = 120_000;
const pwCache = new Map();
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

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || "timed out")), ms)),
  ]);
}

// defeat the MV3 ~30s idle shutdown that kills the session
const KEEPALIVE_ALARM = "open-passwords-keepalive";
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
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

function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc?.passwordSavingEnabled) return;
  // credit-card autofill is never touched, google pay keeps working
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

// content messages carry sender.tab, the popup never does
function isFromOwnUi(sender) {
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

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

// loopback and RFC 6761 reserved TLDs are the only non-HTTPS origins treated as fillable
function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host?.endsWith(".localhost") ||
    host?.endsWith(".test")
  );
}

// only these from a content script, none returns a password to the page
const CONTENT_ALLOWED = new Set([
  "inlineLogins",
  "inlineFill",
  "inlineOneTimeCodes",
  "inlineFillOneTimeCode",
  "requestChallenge",
  "verifyPin",
  "resolveSave",
]);

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== "fill-login") return;
  const tab = await activeTab();
  if (tab?.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: "shortcut" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const fromUi = isFromOwnUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab !== undefined;
      if (!fromUi && !(fromContent && CONTENT_ALLOWED.has(msg?.type))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg?.type) {
        case "inlineLogins": {
          // keyed to sender.url not the top tab
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

        case "inlineOneTimeCodes": {
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          // capabilities arrive with the hello, before the PIN, so locked still knows if codes are supported
          if (!client.ready) return sendResponse({ ok: true, locked: true, supported: client.canFillOneTimeCodes, rows: [] });
          if (!client.canFillOneTimeCodes) return sendResponse({ ok: true, locked: false, supported: false, rows: [] });
          try {
            const { rows, requiresAuth } = await listOneTimeCodes(sender.tab.id, sender.frameId ?? 0, frameUrlsFor(sender));
            sendResponse({ ok: true, locked: false, supported: true, rows, requiresAuth });
          } catch (e) {
            sendResponse({ ok: true, locked: false, supported: true, rows: [], error: String(e?.message ?? e) });
          }
          break;
        }

        case "inlineFillOneTimeCode": {
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) return sendResponse({ ok: false, error: "no frame" });
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          const code = await resolveOneTimeCode(sender.tab.id, Number(msg.id));
          const resp = await chrome.tabs.sendMessage(
            sender.tab.id,
            { type: "fillOtp", code, expectedHost: host },
            { frameId },
          );
          sendResponse({ ok: true, filled: !!resp?.filled });
          break;
        }

        case "inlineFill": {
          // frameId scopes the fill to the requesting frame, never broadcast (confused deputy)
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
          // pass only the username through, sites is caller-supplied
          const safeLogin = { username: msg.loginName?.username };
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
                expectedHost: host,
              },
              { frameId },
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
          // saving here so a submit that navigates cant kill it
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

          // locked: stash a new-password save for unlock, a plain re-login isnt worth deferring
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
          sendResponse({
            ok: true,
            state: client.state,
            hasChallenge: client.hasChallenge,
            caps: {
              oneTimeCodes: client.canFillOneTimeCodes,
              newPasswordSheet: client.canOpenPasswordsAppToNewPasswordSheet,
              setUpTotp: client.canSetUpTotp,
            },
            autoPairError,
          });
          break;

        case "autoPairCheck": {
          const r = await autoPairMsg({ action: "check" });
          sendResponse(r);
          break;
        }

        case "getOneTimeCodes": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          if (!client.ready) return sendResponse({ ok: true, rows: [] });
          if (!client.canFillOneTimeCodes) return sendResponse({ ok: true, supported: false, rows: [] });
          const { rows, requiresAuth } = await listOneTimeCodes(tab.id, 0, frameUrlsFor({ url: tab.url, tab }));
          sendResponse({ ok: true, supported: true, rows, requiresAuth });
          break;
        }

        case "fillOneTimeCode": {
          // every frame gets it, only the one with a code field acts. value returned so the popup can show it if none did
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const host = registrableHost(tab.url);
          if (!/^https:\/\//i.test(tab.url) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const code = await resolveOneTimeCode(tab.id, Number(msg.id));
          let filled = false;
          try {
            const frames = await new Promise((resolve) =>
              chrome.tabs.sendMessage(tab.id, { type: "fillOtp", code, expectedHost: host }, (r) => {
                void chrome.runtime.lastError;
                resolve(r);
              }),
            );
            filled = !!frames?.filled;
          } catch (_) {}
          sendResponse({ ok: true, filled, code });
          break;
        }

        case "openPasswordsApp": {
          const tab = await activeTab();
          const url = tab?.url && /^https?:/i.test(tab.url) ? tab.url : undefined;
          await ensureConnected();
          if (msg.mode === "totp") {
            if (!msg.uri || !/^(apple-)?otpauth:\/\//i.test(msg.uri)) return sendResponse({ ok: false, error: "no otpauth URI" });
            client.launchPasswordsApp({ totpUri: msg.uri, totpPageUrl: url });
          } else if (msg.mode === "new") {
            client.launchPasswordsApp({ newPasswordUrl: url });
          } else {
            client.launchPasswordsApp({ searchUrl: url });
          }
          sendResponse({ ok: true });
          break;
        }

        case "connect":
          await ensureConnected();
          sendResponse({ ok: true, state: client.state });
          break;

        case "requestChallenge":
          // top frame or popup only, so a hostile sub-frame cant spam native prompts
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await ensureConnected();
          await withTimeout(client.requestChallenge({ ifNeeded: !!msg.ifNeeded }), 8000, "challenge timed out");
          // not awaited, the UI shows its PIN box while auto-pair reads the code
          tryAutoPair("request");
          sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge });
          break;

        case "verifyPin": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await ensureConnected();
          try {
            await withTimeout(client.verifyPin(msg.pin), 8000, "verification timed out");
          } catch (e) {
            // a spent challenge cant be retried, put a fresh code up or the user retypes a dead code forever
            let newCode = e?.code === "challenge_reissued";
            if (!newCode && !client.hasChallenge && client.state === State.NeedsPin) {
              try {
                await withTimeout(client.requestChallenge(), 8000, "challenge timed out");
                newCode = true;
              } catch (_) {}
            }
            return sendResponse({
              ok: false,
              error: String(e?.message ?? e),
              newCode,
              state: client.state,
            });
          }
          sendResponse({ ok: true, state: client.state });
          if (client.ready) flushPendingSaves();
          break;
        }

        case "getLogins": {
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
          // re-fill so a password changed in the Passwords app lands without re-clicking Fill
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
              expectedHost: host,
            });
            sendResponse({ ok: true, refilled: !!resp?.filled, username: cred.username });
          } catch (e) {
            sendResponse({ ok: true, refilled: false, error: String(e?.message ?? e) });
          }
          break;
        }

        case "clearCache":
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
  return true;
});
