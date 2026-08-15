// PIN handshake unit tests. runs the real src/srp.js + src/protocol.js against an SRP-6a
// server implemented here, so the whole unlock path is exercised with no macOS helper:
//   node test-harness/automation/pin-session.test.mjs
//
// covers the "keeps saying incorrect PIN" class of bug: a code is only valid for the exact
// challenge it was shown for, so the client must never swap the challenge under the user.

import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, cond });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : " -> " + detail}`);
};

const SRC = new URL("../../src/", import.meta.url);
const { SRPSession } = await import(new URL("srp.js", SRC));
const crypt = await import(new URL("crypto.js", SRC));
const { sha256, bigIntToBytes, bytesToBigInt, padBytes, utf8ToBytes, concatBytes, mod, powmod } = crypt;

const N = BigInt(
  "0x" +
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const NB = 384;
const g = 5n;

// --- SRP-6a server side (the role the macOS helper plays) ------------------------------
// salt is bytes, K is a 32-byte digest: both are hashed as-is, never as trimmed bigints.
class SrpServer {
  constructor({ pin, salt }) {
    this.pin = pin;
    this.salt = salt; // Uint8Array, exactly as sent on the wire
  }
  async start(username, A) {
    this.username = username;
    this.A = A;
    const innerHash = await sha256(utf8ToBytes(username + ":" + this.pin));
    const x = bytesToBigInt(await sha256(this.salt, innerHash));
    this.v = powmod(g, x, N);
    this.b = bytesToBigInt(crypt.randomBytes(32));
    const k = bytesToBigInt(await sha256(bigIntToBytes(N), padBytes(bigIntToBytes(g), NB)));
    this.B = mod(mod(k * this.v, N) + powmod(g, this.b, N), N);
    return { B: this.B, s: this.salt };
  }
  async sharedKey() {
    const u = bytesToBigInt(
      await sha256(padBytes(bigIntToBytes(this.A), NB), padBytes(bigIntToBytes(this.B), NB)),
    );
    const S = powmod(mod(this.A * powmod(this.v, u, N), N), this.b, N);
    return bytesToBigInt(await sha256(bigIntToBytes(S)));
  }
  async expectedM() {
    const K = await this.sharedKey();
    const hN = await sha256(bigIntToBytes(N));
    const hg = await sha256(padBytes(bigIntToBytes(g), NB));
    const xored = new Uint8Array(hN.length);
    for (let i = 0; i < hN.length; i++) xored[i] = hN[i] ^ hg[i];
    return sha256(
      xored,
      await sha256(utf8ToBytes(this.username)),
      this.salt,
      bigIntToBytes(this.A),
      bigIntToBytes(this.B),
      padBytes(bigIntToBytes(K), 32),
    );
  }
  async hamk(m) {
    const K = await this.sharedKey();
    return sha256(bigIntToBytes(this.A), m, padBytes(bigIntToBytes(K), 32));
  }
}

// --- fake native host ------------------------------------------------------------------
// one code per challenge, and a failed verify burns it, like the real helper
function makeHost({ salts, pins }) {
  const state = { codesShown: [], challenges: 0, server: null, live: false };
  let saltIdx = 0;
  let pinIdx = 0;

  const port = {
    _listeners: [],
    _disc: [],
    onMessage: { addListener: (fn) => port._listeners.push(fn) },
    onDisconnect: { addListener: (fn) => port._disc.push(fn) },
    disconnect() {},
    postMessage(msg) {
      setTimeout(() => void handle(msg), 0);
    },
  };
  const reply = (m) => port._listeners.forEach((fn) => fn(m));
  const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
  const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
  const hex = (bytes) => "0x" + crypt.bytesToHex(bytes);
  const unhex = (s) => crypt.hexToBytes(String(s).replace(/^0x/, ""));

  async function handle(msg) {
    if (msg.cmd === 14) return reply({ cmd: 14, capabilities: { shouldUseBase64: false } });
    if (msg.cmd !== 2) return;
    const pake = unb64(msg.msg.PAKE);

    if (msg.msg.QID === "m0") {
      state.challenges++;
      const pin = pins[Math.min(pinIdx++, pins.length - 1)];
      const salt = salts[Math.min(saltIdx++, salts.length - 1)];
      state.codesShown.push(pin);
      state.server = new SrpServer({ pin, salt });
      state.live = true;
      const { B, s } = await state.server.start(pake.TID, bytesToBigInt(unhex(pake.A)));
      return reply({
        cmd: 2,
        payload: { PAKE: b64({ TID: pake.TID, MSG: 1, PROTO: 1, B: hex(bigIntToBytes(B)), s: hex(s) }) },
      });
    }

    // m2: verify
    if (!state.live) return reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: 3, ErrCode: 1 }) } });
    const expected = await state.server.expectedM();
    const got = unhex(pake.M);
    state.live = false; // spent either way, exactly like the helper
    if (Buffer.compare(Buffer.from(expected), Buffer.from(got)) !== 0) {
      return reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: 3, ErrCode: 1 }) } });
    }
    const hamk = await state.server.hamk(got);
    return reply({ cmd: 2, payload: { PAKE: b64({ TID: pake.TID, MSG: 3, ErrCode: 0, HAMK: hex(hamk) }) } });
  }

  globalThis.chrome = { runtime: { connectNative: () => port, lastError: undefined } };
  return state;
}

const leadingZeroSalt = () => {
  const s = crypt.randomBytes(16);
  s[0] = 0x00; // the 1-in-256 case that used to be silently truncated
  return s;
};
const plainSalt = () => {
  const s = crypt.randomBytes(16);
  if (s[0] === 0) s[0] = 0x7f;
  return s;
};

async function freshClient() {
  // re-import per test so each run gets its own module-level client state
  const { ApplePasswords } = await import(new URL(`protocol.js?${Math.random()}`, SRC));
  const c = new ApplePasswords();
  await c.connect();
  return c;
}

// 1. baseline: the code shown unlocks
{
  const host = makeHost({ salts: [plainSalt()], pins: ["123456"] });
  const c = await freshClient();
  await c.requestChallenge();
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("the code shown on the Mac unlocks", c.state === "unlocked" && !err, String(err?.message));
}

// 2. regression: a salt whose first byte is 0x00 must still unlock. round-tripping the salt
// through a bigint dropped that byte and the helper reported it as a wrong PIN
{
  const host = makeHost({ salts: [leadingZeroSalt()], pins: ["123456"] });
  const c = await freshClient();
  await c.requestChallenge();
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("leading-zero salt still unlocks", c.state === "unlocked" && !err, String(err?.message));
}

// 3. the shared key is a 32-byte digest, so a leading-zero K must hash at full width
{
  const salt = plainSalt();
  const s = new SRPSession(false);
  s.setServerPublicKey(2n, salt);
  s.sharedKey = bytesToBigInt(padBytes(new Uint8Array([0x00, 0x11, 0x22]), 32)); // high byte zero
  const m = await s.computeM();
  const expected = await (async () => {
    const hN = await sha256(bigIntToBytes(N));
    const hg = await sha256(padBytes(bigIntToBytes(g), NB));
    const xored = new Uint8Array(hN.length);
    for (let i = 0; i < hN.length; i++) xored[i] = hN[i] ^ hg[i];
    return sha256(
      xored,
      await sha256(utf8ToBytes(s.username)),
      salt,
      bigIntToBytes(s.clientPublicKey),
      bigIntToBytes(2n),
      padBytes(bigIntToBytes(s.sharedKey), 32),
    );
  })();
  ok("leading-zero shared key hashes at full 32 bytes", Buffer.compare(Buffer.from(m), Buffer.from(expected)) === 0);
}

// 4. the whole point: a second prompt must not appear while a code is already up
{
  const host = makeHost({ salts: [plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  await c.requestChallenge({ ifNeeded: true });
  await c.requestChallenge({ ifNeeded: true });
  ok("ifNeeded reuses the live challenge (one code, not three)", host.challenges === 1, `challenges=${host.challenges}`);
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("the first code still works after ifNeeded calls", c.state === "unlocked" && !err, String(err?.message));
}

// 5. concurrent requests collapse into one prompt
{
  const host = makeHost({ salts: [plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await Promise.all([c.requestChallenge(), c.requestChallenge(), c.requestChallenge()]);
  ok("concurrent challenge requests show one code", host.challenges === 1, `challenges=${host.challenges}`);
}

// 6. a code from a superseded challenge is reported as stale, never as "incorrect"
{
  const host = makeHost({ salts: [plainSalt(), plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  const firstCode = host.codesShown[0];
  await c.requestChallenge(); // e.g. the user hit "get a new code"
  let err = null;
  await c.verifyPin(firstCode).catch((e) => (err = e));
  ok("stale code fails as a wrong code, not a crash", !!err && c.state !== "unlocked", String(err?.message));
  // and the code now on screen works on the very next attempt
  await c.requestChallenge();
  let err2 = null;
  await c.verifyPin(host.codesShown[host.codesShown.length - 1]).catch((e) => (err2 = e));
  ok("the newest code unlocks right after a stale one", c.state === "unlocked" && !err2, String(err2?.message));
}

// 7. the loop this fixes: verifying with no live challenge must NOT silently re-challenge and
// grade the old code against the new one - that failed forever, one code behind
{
  const host = makeHost({ salts: [plainSalt(), plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  let bad = null;
  await c.verifyPin("000000").catch((e) => (bad = e)); // wrong code burns the challenge
  ok("wrong code is rejected", !!bad && c.state !== "unlocked", String(bad?.message));
  ok("a spent challenge is not reusable", c.hasChallenge === false);

  let stale = null;
  await c.verifyPin("000000").catch((e) => (stale = e));
  ok(
    "next attempt asks for the NEW code instead of grading the old one",
    stale?.code === "challenge_reissued",
    `code=${stale?.code} msg=${stale?.message}`,
  );
  ok("and a fresh code is on screen for it", c.hasChallenge === true && host.challenges === 2, `challenges=${host.challenges}`);

  let err = null;
  await c.verifyPin(host.codesShown[host.codesShown.length - 1]).catch((e) => (err = e));
  ok("typing that new code unlocks (no infinite incorrect loop)", c.state === "unlocked" && !err, String(err?.message));
}

// 8. an expired code is re-prompted rather than graded
{
  const host = makeHost({ salts: [plainSalt(), plainSalt()], pins: ["111111", "222222"] });
  const c = await freshClient();
  await c.requestChallenge();
  c._challengeAt = Date.now() - 10 * 60_000; // sat unanswered for 10 minutes
  let err = null;
  await c.verifyPin(host.codesShown[0]).catch((e) => (err = e));
  ok("an expired code re-prompts", err?.code === "challenge_reissued" && host.challenges === 2, `${err?.code} challenges=${host.challenges}`);
}

const failed = results.filter((r) => !r.cond);
console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
process.exit(failed.length ? 1 : 0);
