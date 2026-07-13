#!/bin/sh
# registers the "hide browser password manager" policy helper as a native messaging host
# for every chromium browser found. run once after cloning (and again if you move the repo,
# since the host manifest stores this folder's absolute path). macOS only.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="pejdijmoenmkgeppbflobdenhhabjlaj" # the ID our manifest key forces
chmod +x "$DIR/openpasswords-policy.py"

SUPPORT="$HOME/Library/Application Support"
# every chromium browser's native-host dir; only the ones that exist get written
BROWSERS="
Google/Chrome
BraveSoftware/Brave-Browser
BraveSoftware/Brave-Browser-Beta
BraveSoftware/Brave-Browser-Nightly
Microsoft Edge
Chromium
"

n=0
echo "$BROWSERS" | while IFS= read -r b; do
  [ -z "$b" ] && continue
  # write for a browser thats installed (its support dir exists), creating the host subdir
  [ -d "$SUPPORT/$b" ] || continue
  d="$SUPPORT/$b/NativeMessagingHosts"
  mkdir -p "$d"
  cat > "$d/com.openpasswords.policy.json" <<EOF
{
  "name": "com.openpasswords.policy",
  "description": "Open Passwords policy helper",
  "path": "$DIR/openpasswords-policy.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
  echo "  registered for $b"
done

echo
echo "Done. Now FULLY QUIT and reopen your browser (Cmd+Q) so it picks up the helper,"
echo "then open the Open Passwords popup and use the toggle."
