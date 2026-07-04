// client for the macOS PasswordManagerBrowserExtensionHelper over
// chrome.runtime.connectNative("com.apple.passwordmanager").
// flow: GET_CAPABILITIES -> handshake m0 (challenge / PIN prompt) -> user enters
// PIN -> handshake m2 (verify) -> encrypted queries.
// ported from au2001/icloud-passwords-firefox (Apache-2.0). see NOTICE

import { SRPSession, SecretSessionVersion, MSGType } from "./srp.js";
import {
  bytesToBase64,
  base64ToBytes,
  bytesToUtf8,
  bigIntToBytes,
  bytesToBigInt,
  constantTimeEqual,
  QueryStatus,
  queryStatusError,
} from "./crypto.js";

const NATIVE_HOST = "com.apple.passwordmanager";
const BROWSER_NAME = "Chrome";
const VERSION = "1.0";

export const Command = {
  END: 0,
  HANDSHAKE: 2,
  GET_LOGIN_NAMES_FOR_URL: 4,
  GET_PASSWORD_FOR_LOGIN_NAME: 5,
  SET_PASSWORD_FOR_LOGIN_NAME_URL: 6, // save or update a login
  TAB_EVENT: 8,
  PASSWORDS_DISABLED: 9,
  RELOGIN_NEEDED: 10,
  GET_CAPABILITIES: 14,
};

const Action = { UPDATE: 1, SEARCH: 2, ADD_NEW: 3, MAYBE_ADD: 4, GHOST_SEARCH: 5 };

export const State = {
  Disconnected: "disconnected",
  NeedsPin: "needs_pin", // challenge issued, waiting for the user's PIN
  Unlocked: "unlocked", // session key established
  NoHelper: "no_helper", // native host missing
};

function jsonToBase64(obj) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(obj)));
}

export class ApplePasswords {
  constructor() {
    this.port = undefined;
    this.session = undefined;
    this.capabilities = undefined;
    this.state = State.Disconnected;
    this._waiters = new Map(); // cmd -> {resolve, reject, timer}
    this._onState = () => {};
    // native protocol echoes the same cmd on replies with no correlation id, so two
    // in-flight requests with the same cmd collide. serialize all exchanges here
    this._lock = Promise.resolve();
  }

  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    // keep chain alive even if fn rejects, so the next caller still runs
    this._lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  onStateChange(fn) {
    this._onState = fn;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    try {
      this._onState(s);
    } catch (_) {}
  }

  get ready() {
    return (
      this.port !== undefined &&
      this.session !== undefined &&
      this.session.sharedKey !== undefined &&
      this.state === State.Unlocked
    );
  }

  _send(cmd, body = {}, timeoutMs = 5000) {
    if (!this.port) throw new Error("connection closed");
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs == null
          ? null
          : setTimeout(() => {
              this._waiters.delete(cmd);
              reject(new Error("timeout waiting for response"));
            }, timeoutMs);
      this._waiters.set(cmd, { resolve, reject, timer });
      try {
        this.port.postMessage({ cmd, ...body });
      } catch (e) {
        if (timer) clearTimeout(timer);
        this._waiters.delete(cmd);
        reject(e);
      }
    });
  }

  _dispatch(message) {
    const w = this._waiters.get(message.cmd);
    if (w) {
      this._waiters.delete(message.cmd);
      if (w.timer) clearTimeout(w.timer);
      w.resolve(message);
    }
    // unsolicited session-invalidation signals from the helper
    if (message.cmd === Command.PASSWORDS_DISABLED || message.cmd === Command.RELOGIN_NEEDED) {
      this.session = undefined;
      this._setState(State.NeedsPin);
    }
  }

  // does NOT reset an existing unlocked session (core fix vs Apple's extension,
  // which re-pairs on every connect)
  async connect() {
    if (this.port) return;
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST);
      } catch (e) {
        this._setState(State.NoHelper);
        return reject(e);
      }
      this.port = port;

      port.onMessage.addListener((msg) => this._dispatch(msg));
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message;
        this.port = undefined;
        // session key lives only in memory, dropped port means we must re-pair
        this.session = undefined;
        if (err && /not found|forbidden|host/i.test(err)) this._setState(State.NoHelper);
        else this._setState(State.Disconnected);
      });

      this._send(Command.GET_CAPABILITIES)
        .then((reply) => {
          this.capabilities = reply.capabilities ?? {};
          // capabilities flag may be absent or default to "old"; real helper
          // negotiates per-handshake via PROTO (we send + verify RFC there). only
          // reject if capabilities explicitly demand a non-RFC version
          if (
            this.capabilities.secretSessionVersion !== undefined &&
            this.capabilities.secretSessionVersion !== SecretSessionVersion.SRPWithRFCVerification
          ) {
            return reject(new Error("unsupported capabilities (expected SRP RFC verification)"));
          }
          this.session = new SRPSession(this.capabilities.shouldUseBase64);
          this._setState(State.NeedsPin);
          resolve();
        })
        .catch(reject);
    });
  }

  // ask the helper for a challenge. macOS shows the 6-digit PIN access prompt
  async requestChallenge() {
    if (!this.session) throw new Error("not connected");
    // reset prior handshake state
    this.session.serverPublicKey = undefined;
    this.session.salt = undefined;
    this.session.sharedKey = undefined;

    const reply = await this._send(Command.HANDSHAKE, {
      msg: {
        QID: "m0",
        PAKE: jsonToBase64({
          TID: this.session.username,
          MSG: MSGType.ClientKeyExchange,
          A: this.session.serialize(bigIntToBytes(this.session.clientPublicKey)),
          VER: VERSION,
          PROTO: [SecretSessionVersion.SRPWithRFCVerification],
        }),
        HSTBRSR: BROWSER_NAME,
      },
    });

    const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
    if (pake.TID !== this.session.username) throw new Error("challenge for another session");
    if (pake.ErrCode !== undefined) throw new Error(`server hello error ${pake.ErrCode}`);
    if (pake.MSG.toString() !== MSGType.ServerKeyExchange.toString()) throw new Error("unexpected server message");
    if (pake.PROTO !== SecretSessionVersion.SRPWithRFCVerification) throw new Error("unsupported protocol");

    const B = bytesToBigInt(this.session.deserialize(pake.B));
    const s = bytesToBigInt(this.session.deserialize(pake.s));
    this.session.setServerPublicKey(B, s);
    this._setState(State.NeedsPin);
  }

  // if no challenge is pending (inline flow didnt issue one, or it expired) request
  // one first, so we never verify against a half-init session (would hang or throw)
  async verifyPin(pin) {
    if (!this.session) throw new Error("not connected");
    if (this.session.serverPublicKey === undefined || this.session.salt === undefined) {
      await this.requestChallenge();
    }
    try {
      await this.session.setSharedKey(pin);
      const m = await this.session.computeM();

      const reply = await this._send(Command.HANDSHAKE, {
        msg: {
          QID: "m2",
          PAKE: jsonToBase64({
            TID: this.session.username,
            MSG: MSGType.ClientVerification,
            M: this.session.serialize(m, false),
          }),
        },
      });

      const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
      if (pake.TID !== this.session.username) throw new Error("verification for another session");
      if (pake.MSG.toString() !== MSGType.ServerVerification.toString()) throw new Error("unexpected server message");
      if (pake.ErrCode === 1) throw new Error("Incorrect PIN");
      if (pake.ErrCode !== 0 && pake.ErrCode !== undefined) throw new Error(`verification error ${pake.ErrCode}`);

      const hamk = await this.session.computeHMAC(m);
      if (!constantTimeEqual(this.session.deserialize(pake.HAMK), hamk))
        throw new Error("server HAMK mismatch");

      this._setState(State.Unlocked);
    } catch (e) {
      // failed verify spends the challenge, clear it so next verifyPin requests a
      // fresh one and the Mac shows a new code
      this.session.sharedKey = undefined;
      this.session.serverPublicKey = undefined;
      this.session.salt = undefined;
      throw e;
    }
  }

  async _encryptedQuery(cmd, tabId, hostname, payloadBody, timeoutMs) {
    const sdata = this.session.serialize(await this.session.encrypt(payloadBody));
    const reply = await this._send(
      cmd,
      {
        tabId,
        frameId: 0,
        url: hostname,
        payload: { QID: cmd === Command.GET_LOGIN_NAMES_FOR_URL ? "CmdGetLoginNames4URL" : "CmdGetPassword4LoginName", SMSG: JSON.stringify({ TID: this.session.username, SDATA: sdata }) },
      },
      timeoutMs,
    );

    let smsg = reply.payload.SMSG;
    if (typeof smsg === "string") smsg = JSON.parse(smsg);
    if (smsg.TID !== this.session.username) throw new Error("response for another session");
    const data = await this.session.decrypt(this.session.deserialize(smsg.SDATA));
    return JSON.parse(bytesToUtf8(data));
  }

  async getLoginNamesForURL(tabId, url) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        Command.GET_LOGIN_NAMES_FOR_URL,
        tabId,
        hostname,
        { ACT: Action.GHOST_SEARCH, URL: hostname },
        5000,
      );
      if (res.STATUS === QueryStatus.Success)
        return (res.Entries ?? []).map((e) => ({ username: e.USR, sites: e.sites }));
      if (res.STATUS === QueryStatus.NoResults) return [];
      throw queryStatusError(res.STATUS);
    });
  }

  async getPasswordForLoginName(tabId, url, loginName) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        Command.GET_PASSWORD_FOR_LOGIN_NAME,
        tabId,
        // query by trusted frame hostname, never caller-supplied loginName.sites
        // which a page could use to request another origin's password
        hostname,
        { ACT: Action.SEARCH, URL: hostname, USR: loginName.username },
        null, // no timeout, helper may require Touch ID here
      );
      if (res.STATUS === QueryStatus.Success) {
        const e = (res.Entries ?? [])[0];
        return e ? { username: e.USR, password: e.PWD, sites: e.sites } : undefined;
      }
      if (res.STATUS === QueryStatus.NoResults) return undefined;
      throw queryStatusError(res.STATUS);
    });
  }

  // save or update a login in Apple Passwords. cmd 6 with ACT maybeAdd lets the helper
  // decide add-vs-update and drive the native macOS save prompt (with Touch ID). the
  // helper's cmd-6 reply carries no decryptable body so we dont parse one - a page can
  // only ever trigger the OS prompt, never write to the vault silently
  async saveLogin(tabId, url, username, password) {
    if (!this.ready) throw new Error("not unlocked");
    if (!password) throw new Error("no password to save");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const sdata = this.session.serialize(
        await this.session.encrypt({
          ACT: Action.MAYBE_ADD,
          URL: "",
          USR: "",
          PWD: "",
          NURL: hostname,
          NUSR: username ?? "",
          NPWD: password,
        }),
      );
      const body = {
        tabId,
        frameId: 0,
        payload: {
          QID: "CmdNewAccount4URL",
          SMSG: JSON.stringify({ TID: this.session.username, SDATA: sdata }),
        },
      };
      // the ack is empty and user confirmation happens in the native prompt, so a
      // missing or slow ack is not an error
      try {
        await this._send(Command.SET_PASSWORD_FOR_LOGIN_NAME_URL, body, 3000);
      } catch (e) {
        if (!/timeout/i.test(String(e?.message ?? e))) throw e;
      }
      return true;
    });
  }

  disconnect() {
    if (!this.port) return;
    try {
      this.port.postMessage({ cmd: Command.END });
    } catch (_) {}
    try {
      this.port.disconnect();
    } catch (_) {}
    this.port = undefined;
    this.session = undefined;
    this._setState(State.Disconnected);
  }
}
