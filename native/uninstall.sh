#!/bin/sh
# removes the policy helper and restores the browser's own password manager. macOS only.
set -e
SUPPORT="$HOME/Library/Application Support"
for b in \
  "Google/Chrome" \
  "BraveSoftware/Brave-Browser" \
  "BraveSoftware/Brave-Browser-Beta" \
  "BraveSoftware/Brave-Browser-Nightly" \
  "Microsoft Edge" \
  "Chromium"; do
  rm -f "$SUPPORT/$b/NativeMessagingHosts/com.openpasswords.policy.json"
done
# lift the policy itself (ignore if it was never set)
for bundle in com.brave.Browser com.google.Chrome com.microsoft.edgemac org.chromium.Chromium; do
  defaults delete "$bundle" PasswordManagerEnabled 2>/dev/null || true
done
echo "Removed the helper and restored the browser password manager. Restart your browser."
