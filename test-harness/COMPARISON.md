# Password manager side-by-side comparison

A worksheet for comparing two Chrome extensions against the same mock pages:

- Extension A: Apple iCloud Passwords (the official one)
- Extension B: Open Passwords

The goal is to find where each detects fields correctly, where it nags, and where
it fires false positives, especially the 6-box OTP case (`otp-multibox.html`) that
pops Apple's "Enable AutoFill" balloon on every box.

## Setup

1. Serve the folder (don't use `file://`, managers behave more like production over HTTP):
   ```bash
   cd "open-passwords/test-harness"
   ./serve.sh          # or: python3 -m http.server 8765
   ```
   Then open http://localhost:8765/

2. Seed a test credential. Before testing fills, save one credential for
   `localhost:8765` in each manager (e.g. `tester@example.com` plus a throwaway
   password) by submitting `login-standard.html` once and accepting the save
   prompt. Use a throwaway value, never a real credential.

3. Test one extension at a time. Enable A, walk every page, fill the A column. Then
   disable A, enable B, repeat for B. Running both at once makes them fight over
   fields and corrupts the results.

4. What to watch on each field:
   - does an inline icon or key glyph appear?
   - does a dropdown or balloon offer a credential, generated password, or OTP code?
   - how many prompts appear (especially on OTP boxes, one vs six)?
   - does it offer to fill a field it shouldn't (search, reply, newsletter)?
   - does it find fields added after load (iframe, injected form)?

Legend: ✅ correct · ⚠️ partial / clunky · ❌ wrong or nags · — n/a

## 0. Pre-verified field detection (Open Passwords)

Automated results: the content-script classifier was run against each harness page
directly (JSDOM), so they're objective. The live A/B below adds the on-screen
behavior you can only see in Chrome.

| Page | Fields ours targets | OTP boxes ours skips | Correct? |
|---|---|---|---|
| login-standard | username + password | — | ✅ |
| login-twostep | username + password | — | ✅ |
| signup | username + new-password | — | ✅ |
| otp-multibox | nothing | all 6 | ✅ (Apple nags on each box) |
| otp-singlefield | nothing | 1 | ✅ |
| forum | the login form's username + password (not the newsletter email) | — | ✅ |
| tricky | username + password (visibility-gated at fill time) | — | ✅ |

For each page, the live comparison is whether Apple pops the "Enable AutoFill"
balloon where it shouldn't (especially the 6 OTP boxes) and whether it wrongly
targets the forum's newsletter/search boxes.

## 1. Forms and autofill

### 1.1 Standard login, `login-standard.html`
Do: focus the username field, then the password field. Trigger the offer and fill both. Submit, reload, check it offers again.
Expected: one credential offer on username/password; fills both; save prompt on a new login.

| Check | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|
| field icon / decoration appears |  |  |  |
| offers saved credential |  |  |  |
| fills username + password together |  |  |  |
| save prompt on new login |  |  |  |

### 1.2 Two-step login, `login-twostep.html`
Do: fill/confirm username on step 1, click Next. on step 2 the password field is revealed by JS, see if the manager offers to fill it.
Expected: username filled on step 1; on step 2 the newly-shown `current-password` field is detected and offered.

| Check | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|
| offers username on step 1 |  |  |  |
| detects revealed password on step 2 |  |  |  |
| associates it with the same credential |  |  |  |

## 2. Password generation and save

### 2.1 Sign-up, `signup.html`
Do: focus the Password (`new-password`) field. see if a strong password is offered. check it mirrors into Confirm password. submit and watch for a save prompt.
Expected: offers a generated strong password; fills both new-password fields; prompts to save the new credential; does not push an existing saved login here.

| Check | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|
| offers / generates a strong password |  |  |  |
| fills both new-password + confirm |  |  |  |
| save-new prompt after submit |  |  |  |
| does not offer an existing login (correct) |  |  |  |

## 3. One-time codes (the headline test)

### 3.1 OTP, 6 separate boxes, `otp-multibox.html`
Do: click into the first box. watch carefully. then click/tab through boxes 2 to 6.
Expected: treat the six `maxlength="1"` boxes as one OTP field, show at most one prompt and distribute the digits, not a separate balloon on every box.

| Check | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|
| number of prompts/balloons (1 is good, 6 is the bug) |  |  |  |
| shows "Enable AutoFill" nag on every box |  |  |  |
| recognizes the 6 boxes as one OTP field |  |  |  |
| distributes a code across all six boxes |  |  |  |
| overall: annoying vs clean |  |  |  |

### 3.2 OTP, single field, `otp-singlefield.html` (control)
Do: click the single `one-time-code` field.
Expected: one clean prompt; fills the whole field at once; no nagging. baseline to contrast against 3.1.

| Check | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|
| single clean code prompt |  |  |  |
| fills the full field at once |  |  |  |
| no repeated nag |  |  |  |
| difference vs multibox (3.1) |  |  |  |

## 4. False positives

### 4.1 Forum, `forum.html`
Do: click each input in turn: header login (username/password), nav search box, reply body, topic title, sidebar newsletter email.
Expected: offers a credential only on the header login. must not offer on the search box, reply box, topic title, or newsletter email.

| Field | Should offer? | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|---|
| header login (username/password) | yes |  |  |  |
| nav search box | no |  |  |  |
| reply body (textarea) | no |  |  |  |
| topic title (text) | no |  |  |  |
| newsletter email | no |  |  |  |

## 5. Dynamic and edge cases

### 5.1 Tricky page, `tricky.html`
Do: walk all four cards top to bottom. for card 4, wait ~1.5s for the form to inject, then test it.
Expected: fill the iframe login; ignore the hidden password; ideally recognize the no-name password; detect the injected form after it appears.

| Case | Expected | Apple (A) | Open Passwords (B) | Winner / notes |
|---|---|---|---|---|
| 1. login inside iframe, offers fill | fills (same-origin) |  |  |  |
| 2. hidden password field, ignored | not decorated/filled |  |  |  |
| 3. password with no name/id, recognized | ideally offered |  |  |  |
| 4. injected form (after 1.5s), detected | detected via re-scan |  |  |  |

The iframe is same-origin (`iframe-pages/iframe-login.html`) because a real
cross-origin frame can't be hosted locally. real cross-origin iframes (embedded
SSO/checkout) are stricter and some managers refuse to fill them, so keep that
caveat in mind when generalizing.

## Summary scorecard

| Scenario | Apple (A) | Open Passwords (B) | Winner |
|---|---|---|---|
| 1.1 standard login |  |  |  |
| 1.2 two-step login |  |  |  |
| 2.1 sign-up / generate |  |  |  |
| 3.1 OTP 6-box (the bug) |  |  |  |
| 3.2 OTP single field |  |  |  |
| 4.1 forum false-positives |  |  |  |
| 5.1 tricky edge cases |  |  |  |

Headline takeaways

- biggest win for Open Passwords: ____________________________________________
- biggest remaining gap vs Apple: ____________________________________________
- the 6-box OTP result (one prompt vs six balloons): ____________________________________________
