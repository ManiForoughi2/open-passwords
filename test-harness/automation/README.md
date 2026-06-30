# Headless test suite

Automated tests that load the extension in real headless Chrome (Playwright) and
assert the dropdown/fill/PIN behavior across scenarios. They use mock builds of the
extension (the native-helper message handlers are replaced with mocks) so no macOS
helper or real PIN is needed.

## Run

```bash
# 0. one-time: install playwright + chromium somewhere, then point OP_PW at it
#    (or rely on the default /tmp path if present)
npm i playwright && npx playwright install chromium

# 1. generate the mock extension builds
node build-test-extensions.mjs

# 2. serve the harness pages (separate terminal, from test-harness/)
cd .. && python3 -m http.server 8799 --bind 127.0.0.1

# 3. run the whole suite
node run-all.mjs
```

Override paths with env vars if needed:
- `OP_PW`: path to playwright's `index.js`
- `OP_BASE`: harness base URL (default `http://127.0.0.1:8799`)
- `OP_EXT`: load a specific extension build instead of the mock

## What each driver covers

| Driver | Checks |
|---|---|
| `drive.mjs` | Offer on login fields; nothing on OTP/newsletter; locked shows PIN field |
| `drive-adversarial.mjs` | No dropdown on search/tag(Instagram)/comment/checkout/profile; mixed page only on login |
| `drive-bench.mjs` | The combined testbench page, positives + negatives |
| `drive-anchor.mjs` | Fill targets the field you acted on, not another form |
| `drive-clickback.mjs` | Dropdown reappears after click-away-then-back |
| `drive-events.mjs` | `input`/`change` events fire on fill (login isn't rejected) |
| `drive-clickjack.mjs` | A hidden/offscreen password field is NOT filled |
| `drive-multi.mjs` | Chooser lists multiple saved logins |
| `drive-pin.mjs` | Wrong PIN shows error; right PIN unlocks + fills |

Outputs screenshots to `shots/` (gitignored).
