# Verification and audit log

This extension went through independent audits (protocol correctness, security, and
a real-world complaint study), and the findings were resolved. This log records
them, including a mistake in the original "100/100 passing" claim.

## Correction to the original test

The first crypto test reported "100/100 handshakes pass." That test was
self-consistent but wrong: it ran the client against a server simulation that used
the same corrupted group prime and the same IV framing, so both sides agreed while
both were non-standard. The audit caught two real bugs the test couldn't, because
it never compared against the RFC or the helper's actual reply format. The test was
rewritten to assert the prime equals the canonical RFC 5054 value and to decrypt a
response framed the way the helper frames it (IV-first), not the way requests are
framed.

## Critical fixes

| # | Issue | Resolution |
|---|---|---|
| C3 | SRP group prime corrupted: a stray `9` made it 3076 bits, non-standard and weak | replaced with the exact RFC 5054 3072-bit prime; added a startup assertion (768 hex digits). [srp.js](src/srp.js) |
| — | AES-GCM decrypt read the IV from the wrong end. the helper sends replies as `iv ‖ ciphertext` (confirmed against Apple's decompiled `SecretSession.decrypt` and the Firefox reference) | `decrypt()` reads the IV as the first 16 bytes; `encrypt()` keeps IV-last for requests (Apple is intentionally asymmetric). [srp.js](src/srp.js) |
| C1 | any in-extension message could fetch or fill passwords for an attacker-named origin | background rejects messages that aren't from its own UI (`sender.tab === undefined && sender.id === runtime.id`), removed the raw `getPassword` path, and resolves the target tab/origin from the real active tab, never caller input. [background.js](src/background.js) |
| C2 | content script filled without checking origin or visibility; a hidden field on evil.com could capture a fill | fills require the page host to match the pinned `expectedHost`, require an in-extension sender, skip invisible/zero-size/hidden fields, and the background refuses non-HTTPS pages. [content.js](src/content.js), [background.js](src/background.js) |

## Other hardening

- SRP range checks (H1): reject a server public key outside `(0, N)` and reject `u == 0`. [srp.js](src/srp.js)
- downgrade resistance (H2): the per-handshake `PROTO` field is verified; the capabilities flag is treated leniently because the real helper may omit it (matching the reference), so the mode is governed by PROTO negotiation.
- concurrent-query collision: the native protocol echoes the same `cmd` with no correlation id, so overlapping requests could cross-wire or hang. all exchanges are serialized behind a mutex (verified: max concurrency = 1). [protocol.js](src/protocol.js)
- AES key imported `extractable: false`.
- permissions trimmed: dropped `tabs` and `scripting` in favor of `activeTab` plus a statically-declared content script.

## A padding suggestion that was not taken

One audit suggested padding all SRP hash inputs in `computeM` for consistency.
Apple's actual `_calculateM`/`createSessionKey` in the decompiled extension pads
only `g` (and pads `A`, `B` only for the `u` hash), leaving `A`, `B`, `salt`, `K`
unpadded in `M`. This code already matches Apple, so padding would break interop
with the real helper.

## Verified vs not

Verified (automated):
- group prime equals canonical RFC 5054 (384 bytes / 768 hex)
- 100/100 SRP handshakes agree on the shared key against a correct server sim
- `decrypt()` parses helper-framed (IV-first) AES-GCM replies
- SRP range checks reject `B=0` and `B=N`
- request serialization: 5 overlapping calls run strictly one at a time
- manifest references, ES-module import graph, content-script classic-script safety, icons

Not yet verified (requires a Mac and the on-screen PIN):
- the live end-to-end connect → PIN → list → fill against the real helper
- side-by-side behavior vs Apple's extension on real sites (use `test-harness/`)
