#!/usr/bin/python3
# native messaging host for the popup's "hide browser password manager" toggle.
# speaks chrome's length-prefixed json protocol, runs only three fixed `defaults`
# operations on two known bundle ids - no caller input reaches the commands.
# system python3 + absolute defaults path, since browsers launch hosts with a bare env
import json
import struct
import subprocess
import sys

DEFAULTS = "/usr/bin/defaults"
# every chromium browser bundle id, incl brave variants (Origin/Beta/Nightly/Dev). writing to
# one thats not installed is a harmless unused pref
BUNDLES = [
    "com.brave.Browser",
    "com.brave.Browser.origin",
    "com.brave.Browser.beta",
    "com.brave.Browser.nightly",
    "com.brave.Browser.dev",
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.microsoft.edgemac",
    "org.chromium.Chromium",
]
KEY = "PasswordManagerEnabled"


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n))


def send(obj):
    b = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


def hidden():
    # true if any installed browser has the policy set (they're written together)
    for b in BUNDLES:
        r = subprocess.run([DEFAULTS, "read", b, KEY], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip() == "0":
            return True
    return False


def main():
    msg = read_msg()
    action = msg.get("action")
    if action == "set":
        for b in BUNDLES:
            subprocess.run([DEFAULTS, "write", b, KEY, "-bool", "false"])
    elif action == "clear":
        for b in BUNDLES:
            subprocess.run([DEFAULTS, "delete", b, KEY], capture_output=True)
    elif action != "get":
        send({"ok": False, "error": "unknown action"})
        return
    send({"ok": True, "hidden": hidden()})


if __name__ == "__main__":
    main()
