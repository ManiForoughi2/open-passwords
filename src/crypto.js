// crypto + byte helpers for the Apple Passwords native-messaging protocol.
// ported from au2001/icloud-passwords-firefox (Apache-2.0) to browser APIs:
// Uint8Array + bigint + WebCrypto, no Node Buffer. see NOTICE

export function hexToBytes(hex) {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2) hex = "0" + hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function utf8ToBytes(str) {
  return new TextEncoder().encode(str);
}

export function bytesToUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

export function concatBytes(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// bigint <-> big-endian bytes
export function bigIntToBytes(n) {
  if (n === 0n) return new Uint8Array([0]);
  const out = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return new Uint8Array(out);
}

export function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

// left-pad to fixed width, SRP hashing needs PAD() so widths match
export function padBytes(bytes, length) {
  if (bytes.length >= length) return bytes.slice(bytes.length - length);
  const out = new Uint8Array(length);
  out.set(bytes, length - bytes.length);
  return out;
}

// constant-time equality, no early-out on first diff
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(...inputs) {
  const data = concatBytes(...inputs.map((i) => (i instanceof Uint8Array ? i : utf8ToBytes(String(i)))));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export function randomBytes(count) {
  const a = new Uint8Array(count);
  crypto.getRandomValues(a);
  return a;
}

export function mod(a, n) {
  a %= n;
  if (a < 0n) a += n;
  return a;
}

export function powmod(base, exp, n) {
  if (exp < 0n) throw new Error("negative exponent unsupported");
  base = mod(base, n);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, n);
    base = mod(base * base, n);
    exp >>= 1n;
  }
  return result;
}

// status codes returned by the helper
export const QueryStatus = {
  Success: 0,
  GenericError: 1,
  InvalidParam: 2,
  NoResults: 3,
  FailedToDelete: 4,
  FailedToUpdate: 5,
  InvalidMessageFormat: 6,
  DuplicateItem: 7,
  UnknownAction: 8,
  InvalidSession: 9,
};

export function queryStatusError(status) {
  const map = {
    1: "Generic query error",
    2: "Invalid query param",
    3: "No query results",
    4: "Failed to delete",
    5: "Failed to update",
    6: "Invalid message format",
    7: "Duplicate item",
    8: "Unknown action",
    9: "Invalid session",
  };
  return new Error(map[status] ?? `Query error: status ${status}`);
}
