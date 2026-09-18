#!/usr/bin/python3
# reads the 6-digit code off Apple's helper window through System Events, nothing else on screen. needs Accessibility + Automation once
import json
import re
import struct
import subprocess
import sys
import time

HELPER = "PasswordManagerBrowserExtensionHelper"

# the digits may sit in one label ("123456") or one label per digit, so both shapes are collected
DUMP = f'''
tell application "System Events"
  set out to ""
  repeat with p in (every process whose name is "{HELPER}")
    repeat with w in (every window of p)
      try
        set out to out & (name of w as string) & linefeed
      end try
      repeat with e in (every UI element of w)
        try
          set out to out & (value of e as string) & linefeed
        end try
        try
          set out to out & (title of e as string) & linefeed
        end try
        repeat with f in (every UI element of e)
          try
            set out to out & (value of f as string) & linefeed
          end try
          repeat with g in (every UI element of f)
            try
              set out to out & (value of g as string) & linefeed
            end try
          end repeat
        end repeat
      end repeat
    end repeat
  end repeat
  return out
end tell
'''

CHECK = 'tell application "System Events" to return count of processes'


def osascript(script, timeout=10):
    r = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip() or f"osascript exit {r.returncode}")
    return r.stdout


def extract_code(dump):
    lines = [l.strip() for l in dump.splitlines()]
    for l in lines:
        # the helper shows it as "167 313"
        m = re.search(r"(?<!\d)(\d{6})(?!\d)", re.sub(r"[\s-]", "", l))
        if m:
            return m.group(1)
    run = []
    for l in lines:
        if re.fullmatch(r"\d", l):
            run.append(l)
            if len(run) == 6:
                return "".join(run)
        else:
            run = []
    for l in lines:
        m = re.search(r"(?<!\d)(\d(?:[\s-]\d){5})(?!\d)", l)
        if m:
            return re.sub(r"[\s-]", "", m.group(1))
    return None


def permission_hint(err):
    e = str(err)
    if "-1743" in e or "not allowed" in e.lower() or "Not authorized" in e:
        return "allow the browser to control System Events (System Settings > Privacy & Security > Automation)"
    if "-25211" in e or "assistive" in e.lower() or "-1719" in e:
        return "add the browser under System Settings > Privacy & Security > Accessibility"
    return e


def read_code(timeout_ms):
    deadline = time.monotonic() + max(500, min(int(timeout_ms), 20000)) / 1000.0
    last_err = None
    while time.monotonic() < deadline:
        try:
            code = extract_code(osascript(DUMP))
            if code:
                return {"ok": True, "code": code}
        except subprocess.TimeoutExpired:
            last_err = "System Events did not answer"
        except Exception as e:  # noqa: BLE001
            last_err = permission_hint(e)
            # a permission error will not clear by polling
            if last_err != str(e):
                return {"ok": False, "error": last_err}
        time.sleep(0.15)
    return {"ok": False, "error": last_err or "no pairing window with a 6-digit code was visible"}


def send(obj):
    b = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(b)) + b)
    sys.stdout.buffer.flush()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        assert extract_code("Enable Password AutoFill\nEnter this code\n482913\n") == "482913"
        assert extract_code("4\n8\n2\n9\n1\n3\n") == "482913"
        assert extract_code("code 4 8 2 9 1 3 ok") == "482913"
        assert extract_code("Verification Code\nEnable Password AutoFill\n167 313\nDone\n") == "167313"
        assert extract_code("1234567\nno code here\n12345") is None
        print("selftest ok")
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--read":
        print(json.dumps(read_code(int(sys.argv[2]) if len(sys.argv) > 2 else 4000)))
        return
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        sys.exit(0)
    (n,) = struct.unpack("<I", raw)
    req = json.loads(sys.stdin.buffer.read(n))
    action = req.get("action")
    if action == "check":
        try:
            osascript(CHECK, timeout=8)
            send({"ok": True})
        except Exception as e:  # noqa: BLE001
            send({"ok": False, "error": permission_hint(e)})
    elif action == "read":
        send(read_code(req.get("timeoutMs", 6000)))
    else:
        send({"ok": False, "error": "unknown action"})


if __name__ == "__main__":
    main()
