#!/usr/bin/env bash
# Serve this test-harness folder over HTTP so the mock pages behave like real sites.
# Password managers treat http://localhost like a real origin (per-site credential
# association, save prompts, etc.), which file:// does not always do - so prefer this.
#
# Usage:  ./serve.sh         then open  http://localhost:8765/
# Stop:   Ctrl-C
#
# Serve from the directory this script lives in, regardless of where it's called from.
cd "$(dirname "$0")" || exit 1
echo "Serving test harness at http://localhost:8765/  (Ctrl-C to stop)"
exec python3 -m http.server 8765
