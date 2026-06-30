// SRP-6a session for the Apple Passwords protocol. the 6-digit PIN macOS shows is
// the SRP password. after handshake the shared key seeds AES-GCM for the encrypted
// query channel.
// ported from au2001/icloud-passwords-firefox (Apache-2.0). see NOTICE

import {
  sha256,
  randomBytes,
  powmod,
  mod,
  bigIntToBytes,
  bytesToBigInt,
  padBytes,
  hexToBytes,
  bytesToHex,
  base64ToBytes,
  bytesToBase64,
  utf8ToBytes,
  concatBytes,
} from "./crypto.js";

// RFC 5054 appendix A, 3072-bit group. must be exactly the canonical safe prime,
// one wrong digit silently breaks interop with the helper and weakens the group.
// byte length checked below
const GROUP_PRIME = BigInt(
  "0x" +
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF",
);
const GROUP_PRIME_BYTES = 3072 >> 3; // 384
const GROUP_GENERATOR = 5n;

// fail fast if the prime is mis-edited (canonical group is 384 bytes / 768 hex)
if (GROUP_PRIME.toString(16).length !== 768) {
  throw new Error("SRP group prime is corrupt (expected 3072 bits / 768 hex digits)");
}

export const SecretSessionVersion = {
  SRPWithOldVerification: 0,
  SRPWithRFCVerification: 1,
};

export const MSGType = {
  ClientKeyExchange: 0,
  ServerKeyExchange: 1,
  ClientVerification: 2,
  ServerVerification: 3,
};

export class SRPSession {
  constructor(shouldUseBase64 = false) {
    this.shouldUseBase64 = !!shouldUseBase64;
    this.usernameBytes = randomBytes(16);
    this.username = this.serialize(this.usernameBytes);
    this.clientPrivateKey = bytesToBigInt(randomBytes(32));
    this.serverPublicKey = undefined; // B
    this.salt = undefined; // s
    this.sharedKey = undefined; // K, SRP shared key
  }

  get clientPublicKey() {
    return powmod(GROUP_GENERATOR, this.clientPrivateKey, GROUP_PRIME); // A
  }

  serialize(bytes, prefix = true) {
    if (this.shouldUseBase64) return bytesToBase64(bytes);
    return (prefix ? "0x" : "") + bytesToHex(bytes);
  }

  deserialize(str) {
    if (this.shouldUseBase64) return base64ToBytes(str);
    return hexToBytes(str.replace(/^0x/, ""));
  }

  setServerPublicKey(serverPublicKey, salt) {
    // RFC 5054: abort if B % N == 0, keep B strictly in (0, N)
    if (serverPublicKey <= 0n || serverPublicKey >= GROUP_PRIME)
      throw new Error("invalid server public key: out of range");
    if (mod(serverPublicKey, GROUP_PRIME) === 0n) throw new Error("invalid server public key");
    this.serverPublicKey = serverPublicKey;
    this.salt = salt;
  }

  async setSharedKey(pin) {
    if (this.serverPublicKey === undefined) throw new Error("missing server public key");
    if (this.salt === undefined) throw new Error("missing salt");

    const A = bigIntToBytes(this.clientPublicKey);
    const B = bigIntToBytes(this.serverPublicKey);

    // u = H(PAD(A) | PAD(B)); RFC 5054 requires u != 0 or the password is bypassed
    const u = bytesToBigInt(await sha256(padBytes(A, GROUP_PRIME_BYTES), padBytes(B, GROUP_PRIME_BYTES)));
    if (u === 0n) throw new Error("invalid SRP parameter: u == 0");
    // k = H(N | PAD(g))
    const k = bytesToBigInt(
      await sha256(bigIntToBytes(GROUP_PRIME), padBytes(bigIntToBytes(GROUP_GENERATOR), GROUP_PRIME_BYTES)),
    );
    // x = H(salt | H(I ":" P))
    const innerHash = await sha256(utf8ToBytes(this.username + ":" + pin));
    const x = bytesToBigInt(await sha256(bigIntToBytes(this.salt), innerHash));

    // S = (B - k * g^x) ^ (a + u * x) % N
    const base = mod(this.serverPublicKey - mod(k * powmod(GROUP_GENERATOR, x, GROUP_PRIME), GROUP_PRIME), GROUP_PRIME);
    const exp = this.clientPrivateKey + u * x;
    const S = powmod(base, exp, GROUP_PRIME);

    this.sharedKey = bytesToBigInt(await sha256(bigIntToBytes(S)));
  }

  // M = H( H(N) XOR H(g) | H(I) | s | A | B | K )
  async computeM() {
    if (this.sharedKey === undefined) throw new Error("missing shared key");
    const hN = await sha256(bigIntToBytes(GROUP_PRIME));
    const hg = await sha256(padBytes(bigIntToBytes(GROUP_GENERATOR), GROUP_PRIME_BYTES));
    const hI = await sha256(utf8ToBytes(this.username));
    const xored = new Uint8Array(hN.length);
    for (let i = 0; i < hN.length; i++) xored[i] = hN[i] ^ hg[i];

    return await sha256(
      xored,
      hI,
      bigIntToBytes(this.salt),
      bigIntToBytes(this.clientPublicKey),
      bigIntToBytes(this.serverPublicKey),
      bigIntToBytes(this.sharedKey),
    );
  }

  // HAMK = H( A | M | K )
  async computeHMAC(m) {
    return await sha256(bigIntToBytes(this.clientPublicKey), m, bigIntToBytes(this.sharedKey));
  }

  async getEncryptionKey() {
    if (this.sharedKey === undefined) return undefined;
    // session key is first 16 bytes of the 32-byte SHA-256 shared key. pad to 32
    // first: if the bigint high byte is zero, bigIntToBytes returns a short buffer
    // and slicing would drop a leading zero, giving the wrong key
    const key = padBytes(bigIntToBytes(this.sharedKey), 32).slice(0, 16);
    return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  // outbound framing is ciphertext+tag || iv (IV appended last). Apple's
  // SecretSession.encrypt does concat(ciphertext, iv), helper expects that
  async encrypt(obj) {
    const key = await this.getEncryptionKey();
    if (!key) throw new Error("missing encryption key");
    const iv = randomBytes(16);
    const plaintext = utf8ToBytes(JSON.stringify(obj));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
    return concatBytes(ct, iv);
  }

  // inbound framing is iv || ciphertext+tag. Apple's SecretSession.decrypt reads
  // the IV as the first 16 bytes (bitSlice(e,0,keyLen)), Firefox ref does the same.
  // asymmetric with encrypt() on purpose, we never decrypt our own output
  async decrypt(bytes) {
    const key = await this.getEncryptionKey();
    if (!key) throw new Error("missing encryption key");
    const iv = bytes.slice(0, 16);
    const ct = bytes.slice(16);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    return pt;
  }
}
