#!/bin/sh
# macOS only
set -e
SUPPORT="$HOME/Library/Application Support"
for d in "$SUPPORT/Google/Chrome"* "$SUPPORT/Microsoft Edge" "$SUPPORT/Chromium" "$SUPPORT/Arc/User Data" "$SUPPORT/Vivaldi" "$SUPPORT/BraveSoftware/"*/; do
  rm -f "${d%/}/NativeMessagingHosts/com.openpasswords.policy.json" 2>/dev/null || true
  rm -f "${d%/}/NativeMessagingHosts/com.openpasswords.autopair.json" 2>/dev/null || true
done
for bundle in com.brave.Browser com.brave.Browser.origin com.brave.Browser.beta com.brave.Browser.nightly com.brave.Browser.dev com.google.Chrome com.google.Chrome.beta com.google.Chrome.dev com.google.Chrome.canary com.microsoft.edgemac org.chromium.Chromium company.thebrowser.Browser com.vivaldi.Vivaldi; do
  defaults delete "$bundle" PasswordManagerEnabled 2>/dev/null || true
done
rm -rf "$SUPPORT/OpenPasswords"
echo "Removed the helper and restored the browser password manager. Restart your browser."
