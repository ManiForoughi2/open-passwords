#!/usr/bin/python3
# native messaging host for the popup's "hide browser password manager" toggle.
# a plain `defaults write` is NOT a forced policy on macOS (the browser ignores it), so this
# generates a configuration profile and opens it - the user approves it once in System
# Settings and then PasswordManagerEnabled=false is a real managed policy. speaks chrome's
# length-prefixed json protocol; runs only `open` on files/urls it builds itself.
import ctypes
import json
import os
import struct
import subprocess
import sys
import uuid

# chrome + brave variants (Origin/Beta/Nightly/Dev) + edge/chromium
BUNDLES = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.brave.Browser",
    "com.brave.Browser.origin",
    "com.brave.Browser.beta",
    "com.brave.Browser.nightly",
    "com.brave.Browser.dev",
    "com.microsoft.EdgeMac",
    "org.chromium.Chromium",
]
KEY = "PasswordManagerEnabled"
APPDIR = os.path.expanduser("~/Library/Application Support/OpenPasswords")
PROFILE = os.path.join(APPDIR, "OpenPasswords-HidePasswordManager.mobileconfig")

_CF = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
_CF.CFStringCreateWithCString.restype = ctypes.c_void_p
_CF.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
_CF.CFPreferencesAppValueIsForced.restype = ctypes.c_bool
_CF.CFPreferencesAppValueIsForced.argtypes = [ctypes.c_void_p, ctypes.c_void_p]


def _cfstr(x):
    return _CF.CFStringCreateWithCString(None, x.encode(), 0x08000100)


def is_forced():
    # true only when a managed profile actually forces the key - the real "is it hidden" signal
    k = _cfstr(KEY)
    return any(_CF.CFPreferencesAppValueIsForced(k, _cfstr(b)) for b in BUNDLES)


def write_profile():
    import plistlib

    payloads = []
    for b in BUNDLES:
        payloads.append(
            {
                "PayloadType": b,
                "PayloadIdentifier": "com.openpasswords.hidepm." + b,
                "PayloadUUID": str(uuid.uuid4()).upper(),
                "PayloadEnabled": True,
                "PayloadVersion": 1,
                KEY: False,
            }
        )
    profile = {
        "PayloadType": "Configuration",
        "PayloadDisplayName": "Open Passwords - Hide Browser Password Manager",
        "PayloadDescription": "Disables the built-in password manager in Chrome/Brave.",
        "PayloadIdentifier": "com.openpasswords.hidepm",
        "PayloadUUID": "1D8B2E90-0000-4000-A000-4F70656E5057",
        "PayloadVersion": 1,
        "PayloadRemovalDisallowed": False,
        "PayloadContent": payloads,
    }
    os.makedirs(APPDIR, exist_ok=True)
    with open(PROFILE, "wb") as f:
        plistlib.dump(profile, f)


def send(obj):
    b = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


def main():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    (n,) = struct.unpack("<I", raw)
    action = json.loads(sys.stdin.buffer.read(n)).get("action")

    if action == "set":
        # build + open the profile; the user approves it in System Settings to make it stick
        write_profile()
        subprocess.run(["open", PROFILE])
        send({"ok": True, "hidden": is_forced(), "needsApproval": not is_forced()})
    elif action == "clear":
        # profiles can only be removed by the user in System Settings; open that pane
        subprocess.run(["open", "x-apple.systempreferences:com.apple.preferences.configurationprofiles"])
        send({"ok": True, "hidden": is_forced()})
    elif action == "get":
        send({"ok": True, "hidden": is_forced()})
    else:
        send({"ok": False, "error": "unknown action"})


if __name__ == "__main__":
    main()
