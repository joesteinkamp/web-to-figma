#!/bin/bash
# Wrapper to launch the Python native messaging host.
# Some Chromium-based browsers (e.g. Dia, Arc) cannot exec Python scripts
# directly via shebang — they require a shell script entry point.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Find python3 — /usr/bin/python3 may not exist on newer macOS without
# Xcode Command Line Tools. Check Homebrew and other common locations.
for PYTHON in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  [ -x "$PYTHON" ] && break
done
[ -x "$PYTHON" ] || PYTHON=$(which python3 2>/dev/null) || PYTHON="python3"

exec "$PYTHON" "$SCRIPT_DIR/host.py" "$@"
