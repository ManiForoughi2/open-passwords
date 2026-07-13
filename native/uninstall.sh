#!/bin/sh
# removes the policy helper and restores the browser's own password manager. macOS only.
set -e
SUPPORT="$HOME/Library/Application Support"
# every chrome/edge/chromium dir plus every BraveSoftware/* variant
for d in "$SUPPORT/Google/Chrome"* "$SUPPORT/Microsoft Edge" "$SUPPORT/Chromium" "$SUPPORT/BraveSoftware/"*/; do
  rm -f "${d%/}/NativeMessagingHosts/com.openpasswords.policy.json" 2>/dev/null || true
done
# lift the policy itself (ignore if it was never set)
for bundle in com.brave.Browser com.brave.Browser.origin com.brave.Browser.beta com.brave.Browser.nightly com.brave.Browser.dev com.google.Chrome com.google.Chrome.beta com.google.Chrome.dev com.google.Chrome.canary com.microsoft.edgemac org.chromium.Chromium; do
  defaults delete "$bundle" PasswordManagerEnabled 2>/dev/null || true
done
# remove the installed helper copy
rm -rf "$SUPPORT/OpenPasswords"
echo "Removed the helper and restored the browser password manager. Restart your browser."
