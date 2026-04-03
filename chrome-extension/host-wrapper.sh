#!/bin/bash
# Wrapper to launch the Python native messaging host.
# Some Chromium-based browsers (e.g. Dia, Arc) cannot exec Python scripts
# directly via shebang — they require a shell script entry point.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec /usr/bin/python3 "$SCRIPT_DIR/host.py" "$@"
