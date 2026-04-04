#!/bin/bash
# Wrapper to launch the Node.js native messaging host.
# Some Chromium-based browsers (e.g. Dia, Arc) cannot exec Node scripts
# directly via shebang — they require a shell script entry point.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Find node in common locations since Chrome's PATH may be minimal
for NODE in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  [ -x "$NODE" ] && break
done
[ -x "$NODE" ] || NODE=$(which node 2>/dev/null) || NODE="node"
exec "$NODE" "$SCRIPT_DIR/host.js" "$@"
