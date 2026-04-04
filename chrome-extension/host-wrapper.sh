#!/bin/bash
# Wrapper to launch the Node.js native messaging host.
# Some Chromium-based browsers (e.g. Dia, Arc) cannot exec Node scripts
# directly via shebang — they require a shell script entry point.
#
# Chrome spawns native messaging hosts with a minimal environment, so we
# must search common install locations for the node binary.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/.web-to-figma-host.log"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) WRAPPER $1" >> "$LOG" 2>/dev/null
}

log "Started. PATH=$PATH"

# Search for node in common locations
NODE=""
CANDIDATES=(
  /usr/local/bin/node
  /opt/homebrew/bin/node
)

# Add nvm paths (expand glob, pick latest version)
for p in "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$p" ] && CANDIDATES+=("$p")
done

# Add volta path
[ -x "$HOME/.volta/bin/node" ] && CANDIDATES+=("$HOME/.volta/bin/node")

# Add fnm paths
for p in "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node; do
  [ -x "$p" ] && CANDIDATES+=("$p")
done

# Try each candidate
for p in "${CANDIDATES[@]}"; do
  if [ -x "$p" ]; then
    NODE="$p"
    break
  fi
done

# Fall back to PATH
if [ -z "$NODE" ]; then
  NODE=$(which node 2>/dev/null) || true
fi

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  log "ERROR: node not found. Searched: ${CANDIDATES[*]}"
  # Send a native messaging error response so the extension shows a useful message
  ERROR='{"error":"Node.js not found. Install from https://nodejs.org"}'
  LEN=${#ERROR}
  printf "\\x$(printf '%02x' $((LEN & 0xFF)))\\x$(printf '%02x' $(((LEN >> 8) & 0xFF)))\\x00\\x00"
  printf '%s' "$ERROR"
  exit 1
fi

log "Using node: $NODE"
exec "$NODE" "$SCRIPT_DIR/host.js" "$@"
