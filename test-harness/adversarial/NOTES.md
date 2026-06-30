# Adversarial no-autofill test pages: selector reference

These pages reproduce real-world non-login text inputs and verify the extension
does not show its autofill dropdown where it shouldn't. They were created after a
reported bug where the dropdown wrongly appeared on Instagram's Tag [Search] box.

For every selector under "NO dropdown", focusing the field must produce no "Open
Passwords" box. For the "SHOULD show dropdown" list (mixed-page), focusing the
field must produce the dropdown, the positive control proving the extension still
fires when it legitimately should.

How the extension decides (from `src/content.js`, `isLoginField`):
- a `type="password"` field always qualifies
- a username-ish field (matches `/user|email|login|account/i` on
  name/id/aria-label/placeholder/autocomplete, or `autocomplete` contains
  `username`/`email`) qualifies only if it is `autocomplete="username"`, or its form
  is not `autocomplete="off"` and a password field exists in the same form (a
  formless username field also qualifies)
- OTP fields are excluded

Each NO-dropdown field fails at least one of those gates (not username-ish, form
opted out, or no password in the form).

## search-bar.html, NO dropdown
- `#header-search`: `<input type="search">`, formless, in the nav bar
- `#inline-search`: `<input type="search">`, formless
- `#form-search`: `<input type="search" name="q">` inside `<form role="search">` (no password in form)

## social-tag.html, NO dropdown
- `#tag-search`: `<input type="text" placeholder="Search" aria-label="Tag people">`, formless (the literal repro)
- `#tag-combobox`: `<input role="combobox" aria-expanded="false" placeholder="Search">`, formless

## compose-message.html, NO dropdown
- `#dm-input`: `<input type="text" placeholder="Message..." aria-label="Message">`, formless
- `#compose-textarea`: `<textarea>` (textareas are never login fields)
- `#compose-editable`: `contenteditable` div (not an `<input>`)

## comment-box.html, NO dropdown
- `#comment-input`: `<input type="text" name="comment">` (form is `autocomplete="off"`, no password)
- `#reply-input`: `<input type="text" name="reply">`, formless

## checkout-address.html, NO dropdown
- `#first-name`: `name="first-name"`, `autocomplete="shipping given-name"`
- `#last-name`: `name="last-name"`, `autocomplete="shipping family-name"`
- `#address`: `name="address"`, `autocomplete="shipping address-line1"`
- `#city`: `name="city"`, `autocomplete="shipping address-level2"`
- `#postal-code`: `name="postal-code"`, `autocomplete="shipping postal-code"`
- `#email`: `type="email"`, `name="email"`, `autocomplete="email"` (username-ish, but no password in the form, so not a login)

## newsletter.html, NO dropdown
- `#newsletter_email`: `<input type="email" name="newsletter_email">` inside `<form autocomplete="off">` (form opted out, no password)

## profile-edit.html, NO dropdown
- `#display-name`: `name="name"`, `autocomplete="name"`
- `#profile-email`: `type="email"`, `name="email"`, `autocomplete="email"` (username-ish, but no password in the form, so not a login)
- `#profile-phone`: `type="tel"`, `name="phone"`, `autocomplete="tel"`

## mixed-page.html, split behavior
NO dropdown:
- `#header-search`: `<input type="search" name="q">`, formless, in nav
- `#body-search`: `<input type="search">`, formless

SHOULD show dropdown (positive control, a real login form):
- `#login-username`: `<input type="text" name="username" autocomplete="username">`
- `#login-password`: `<input type="password" name="password" autocomplete="current-password">`

## Flat selector lists (for automated tests)

### MUST NOT show the dropdown
```
search-bar.html        #header-search, #inline-search, #form-search
social-tag.html        #tag-search, #tag-combobox
compose-message.html   #dm-input, #compose-textarea, #compose-editable
comment-box.html       #comment-input, #reply-input
checkout-address.html  #first-name, #last-name, #address, #city, #postal-code, #email
newsletter.html        #newsletter_email
profile-edit.html      #display-name, #profile-email, #profile-phone
mixed-page.html        #header-search, #body-search
```

### MUST show the dropdown (positive control)
```
mixed-page.html        #login-username, #login-password
```
