# Apple iCloud Passwords complaints, and how Open Passwords compares

This maps 18 documented complaints about Apple's official iCloud Passwords
Chrome/Edge extension to what Open Passwords does. "Verified" means an automated
headless test in `test-harness/` proves it (real Chrome plus the extension).
Sources are user reports across the Chrome Web Store, Apple Communities,
Google/Brave forums, GitHub, AppleInsider, and Macworld.

Legend: ✅ fixed · 🟡 partial · ⛔ inherent (no extension can fix)

| # | Complaint | Apple's behavior | Open Passwords | Status |
|---|---|---|---|---|
| 1 | Constant re-prompt for the 6-digit code (the top complaint) | re-pairs every restart and often every few hours; resets the session on every capabilities reload | keep-alive holds the MV3 worker and the live session, and it never resets on a benign reconnect, so the frequent mid-session re-prompts are gone. only a full browser restart re-pairs (the session key is bound to the connection; Apple and au2001 both re-handshake per connection) | ✅/⛔ |
| 2 | Verification code never arrives | helper deadlocks; says code generated, none appears | 8s timeout plus a clear error instead of hanging; a broken helper is helper-side | 🟡 |
| 3 | "Failed to verify your identity" | server/helper rejects the browser | helper-side / Apple gating | ⛔ |
| 4 | "Enable AutoFill" balloon on every OTP box and random fields | pops on one-time-code boxes and non-login fields | never shows on OTP fields, search, tag, comment, etc. verified: 22/22 adversarial pages show nothing; OTP pages show nothing | ✅ |
| 5 | High CPU / typing lag | re-scans the DOM and re-attaches listeners on every keystroke | zero per-keystroke or DOM-scan work, only a `focusin` listener. no typing cost | ✅ |
| 6 | Double popups vs Chrome's manager | both managers fight over the field | suppresses only Chrome's password autofill (see #7) so there's one clean dropdown | ✅ |
| 7 | Breaks Google Pay / payment autofill | Apple's "disable Chrome autofill" also kills credit-card and address autofill | suppresses only `passwordSavingEnabled`; Chrome's payment and address autofill keep working | ✅ |
| 8 | Two-step (username then password) logins fail | doesn't re-detect the dynamically-shown password field | `autocomplete="username"` plus page-wide password detection handles Google/Microsoft-style two-step. verified in the UI suite | ✅ |
| 9 | Fills, but login fails until you edit a char | programmatic fill doesn't dispatch `input`/`change`, so the page's JS never sees the value | dispatches real `input` and `change` events on every fill. verified: events fire on both fields | ✅ |
| 10 | Subdomain / domain-matching failures | strict exact-host matching | passes the full hostname to the helper, which does Apple's own associated-domain matching | 🟡 |
| 11 | Popup obscures the screen / can't dismiss | overlay z-index and positioning bugs, premature dismissal | the dropdown anchors under the field, closes on outside-click/scroll/resize, and never covers the field | ✅ |
| 12 | "Never save" flag stuck, unclearable off-Mac | no UI to clear it | no save-flag management yet (no save feature) | ⛔/N-A |
| 13 | Save-new-password auto-saves without consent | aggressive auto-capture | no auto-save, no silent capture; also no save prompt yet | 🟡 |
| 14 | No Linux support | needs the macOS/Windows helper | same constraint, the helper only exists on macOS/Windows | ⛔ |
| 15 | Touch ID re-prompt friction | re-prompts per fill | the OS controls the biometric gate (`RequiresUserAuthenticationToFill`); can't be removed | ⛔ |
| 16 | Dark-mode toolbar icon invisible | single-color icon | UI uses `Canvas`/`CanvasText` system colors (theme-aware); icon TODO | 🟡 |
| 17 | Windows version coupling | tied to a specific iCloud-for-Windows build | helper-side | ⛔ |
| 18 | Clickjacking / autofill UI-redressing (Marek Tóth 2025; affects Apple, 1Password, Bitwarden) | autofills into invisible/overlaid fields | requires visible fields (size/opacity/offscreen checks), an explicit user click, and origin-pinning. verified: a hidden offscreen password field is not filled | ✅ |

## What it fixes that Apple doesn't

- the OTP-balloon and false-positive firing (#4): 22/22 adversarial pages clean
- frequent re-prompting within a session (#1): keep-alive plus no-reset
- the "edit a char to make login work" bug (#9): proper input events
- breaking Google Pay (#7): payment autofill untouched
- typing lag (#5): no per-keystroke work
- clickjacking exfiltration (#18): visibility, intent, and origin checks

## What it can't fix

- Linux (#14), Windows helper coupling (#17), the "unsupported browser" rejection
  (#3), and the helper-side parts of #2 all require Apple's native helper, which no
  extension controls.
- the Touch ID prompt (#15) and the once-per-browser-restart re-pair (#1): the OS
  and the protocol require them, and Apple's extension has them too.

## Not yet built

- a save-new-password prompt (#13) and a settings UI to clear "never save" (#12)

Every ✅ above is backed by an automated test in `test-harness/automation/`. Totals
at last run: 22/22 adversarial, 17/17 UI, 4/4 PIN, plus multi-account, input-events
(#9), and clickjacking (#18).
