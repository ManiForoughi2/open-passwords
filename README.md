<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="Open Passwords logo">
</p>

<h1 align="center">Open Passwords</h1>

<p align="center">
  A Chrome/Edge extension that talks to Apple Passwords (iCloud Keychain) on macOS and autofills your logins, without the official extension's headaches.
</p>

---

Apple's official iCloud Passwords extension for Chrome sits at 2.3 out of 5 across ~2,600 ratings. It forgets your session and re-asks for the 6-digit code every few hours, throws an "Enable AutoFill" balloon on top of one-time-code boxes, and fights Chrome's own password manager. This is a replacement client.

It speaks the same native-messaging protocol Apple's extension uses (`com.apple.passwordmanager`): an SRP-6a handshake where the 6-digit code your Mac shows you is the shared secret, then an AES-GCM encrypted channel for the password queries. Same vault, same OS authorization, with saner client behavior.

It connects to the live vault, prompts for the PIN once, lists the logins for the current site, and fills them.

## What it fixes

| The complaint about Apple's extension | What this does |
|---|---|
| re-prompts for the 6-digit code every restart, sometimes every few hours | a keep-alive alarm holds the MV3 worker and the session alive, so you enter the code once per real session ([background.js](src/background.js)) |
| "Enable AutoFill" balloon on every field, including OTP boxes | the inline dropdown shows up only on genuine login fields and never on one-time-code boxes ([content.js](src/content.js)) |
| 100% CPU / typing lag | the content script does zero per-keystroke work, it only reacts when you focus a login field |
| re-downloads every image on hover to scan for QR codes | there's no image or QR scanning here at all |
| fills the wrong field or wrong origin | fills are pinned to the page's origin and skip hidden/clickjacked fields |

You fill two ways: the inline dropdown when you focus a login field, or the toolbar popup. Both run through the same origin-checked, OS-authorized path.

## The catch you should know about first

This is a sideload-from-GitHub tool. It can't go on the Chrome Web Store, and the reason is in macOS itself.

macOS 14+ ships a native helper called `PasswordManagerBrowserExtensionHelper`. On macOS 15.4 and later that helper only accepts connections from two hard-coded extension IDs, Apple's own Chrome and Edge extensions. Those IDs are compiled into the signed system binary, and it refuses everything else.

So to connect at all, this extension's `manifest.json` carries the public `key` from Apple's extension, which makes Chrome assign it the one ID the helper accepts: `pejdijmoenmkgeppbflobdenhhabjlaj`. That's the only way a Chrome extension reaches the helper on current macOS.

What that means for you:

- it works when loaded unpacked for personal use
- it can't be published to the Web Store, because that ID and key belong to Apple
- you have to disable Apple's official iCloud Passwords extension first, since two extensions can't share one ID in the same profile

For a publishable browser client, Firefox is the path that works, see [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox). Chrome is locked to Apple's IDs.

### Why an own-ID version isn't possible

On macOS 15.4+, reading the live vault needs either Apple's native helper (which demands one of Apple's two IDs) or an Apple-only keychain entitlement. Every other route dead-ends:

| Route | What happened |
|---|---|
| spawn the helper via a proxy native host | killed by the helper's parent launch constraint, the parent has to be a whitelisted browser |
| own extension ID into the helper | rejected, the allowed IDs are hardcoded in the signed binary |
| `security` CLI / `Security.framework` | returns 0 synchronizable items, it can't see the iCloud vault |
| read `keychain-2.db` directly | the SQLite is readable but the password blobs are encrypted, keys gated by Apple-only entitlements |
| Apple's [`password-manager-resources`](https://github.com/apple/password-manager-resources) contribution process | only authorizes browsers by signing identity through OS updates, no path for a third-party extension |

Borrowing Apple's key is the only way in. The evidence is in [VERIFICATION.md](VERIFICATION.md).

## Requirements

- macOS 14 (Sonoma) or later, signed into iCloud with Passwords on
- Chrome or Edge
- Apple's official iCloud Passwords extension removed or disabled

## Install

```bash
git clone https://github.com/ManiForoughi2/open-passwords.git
```

1. disable Apple's official iCloud Passwords extension (it claims the same ID)
2. open `chrome://extensions` and turn on Developer mode (top right)
3. click Load unpacked and pick the `open-passwords` folder
4. confirm the ID reads `pejdijmoenmkgeppbflobdenhhabjlaj`
5. click the toolbar icon, type the 6-digit code your Mac shows, done
6. go to a site with a saved login and fill it

### Optional: hide the browser's own password manager

The popup can suppress the browser's competing save bubble and autofill dropdown on its own (toggles in the footer). To also remove the browser's whole password manager — the omnibox key icon and built-in autofill — there's a one-time helper, since an extension can't write a macOS policy by itself:

```bash
./native/install.sh   # registers a tiny native helper, macOS only
```

Then fully quit and reopen your browser (`Cmd+Q`). The **Hide browser password manager entirely** toggle in the popup now works; it sets `PasswordManagerEnabled=false` for every Chromium browser you have. Undo anytime with `./native/uninstall.sh`. The helper only runs three fixed `defaults` commands and accepts messages solely from this extension's ID.

## How it works

```
popup.js / content.js
        │  runtime messages
        ▼
background.js  ──  keep-alive alarm keeps the session warm
        │
        ▼
protocol.js  ──  chrome.runtime.connectNative("com.apple.passwordmanager")
        │            GET_CAPABILITIES → m0 (challenge/PIN) → m2 (verify) → queries
        ▼
srp.js + crypto.js   SRP-6a (RFC 5054, 3072-bit) + AES-GCM session
        ▼
PasswordManagerBrowserExtensionHelper (macOS native, talks to iCloud Keychain)
```

## What it doesn't fix

- the macOS authorization prompt. when the helper reads a password, macOS itself asks for Touch ID or your login password. that's the per-credential `RequiresUserAuthenticationToFill` flag set by the vault. Chrome's built-in manager skips it only because it keeps passwords in its own database instead of the iCloud vault, and removing it would mean giving up live vault access.
- no Linux. same as Apple, the native helper only exists on macOS and Windows.
- no passkey or TOTP management. out of scope, this reads passwords and login names.
- it still rides on Apple's helper. if Apple changes or breaks it, like past macOS updates have, this breaks too.

## Security notes

- the session key lives only in the worker's memory and is never written to disk
- every password query is AES-GCM encrypted end to end with the helper
- the PIN only derives the SRP shared key, it isn't stored
- reading a password can trigger a Touch ID prompt, that's the helper, not this extension

## Credits

The protocol implementation is derived from [au2001/icloud-passwords-firefox](https://github.com/au2001/icloud-passwords-firefox) (Apache-2.0). See [`NOTICE`](./NOTICE).

## License

Apache-2.0. See [`LICENSE`](./LICENSE).

Not affiliated with or endorsed by Apple Inc.
