#!/bin/bash
# Registers the native messaging host for the Web to Figma extension.
# Installs the manifest for all detected Chromium-based browsers.

set -e

HOST_NAME="com.web_to_figma.capture"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.web-to-figma"

# Copy wrapper and host to a stable location outside the repo.
# Some browsers (e.g. Dia) cannot exec scripts from certain directories.
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/host-wrapper.sh" "$INSTALL_DIR/host-wrapper.sh"
cp "$SCRIPT_DIR/host.py" "$INSTALL_DIR/host.py"
cp -r "$SCRIPT_DIR/skills" "$INSTALL_DIR/skills" 2>/dev/null || true
chmod +x "$INSTALL_DIR/host-wrapper.sh"
HOST_SCRIPT="$INSTALL_DIR/host-wrapper.sh"

# Get extension ID
if [ -n "$1" ]; then
  EXT_ID="$1"
else
  echo "Enter your extension ID (find it at chrome://extensions or the equivalent):"
  read -r EXT_ID
fi

if [ -z "$EXT_ID" ]; then
  echo "Error: Extension ID is required."
  exit 1
fi

# Verify python3 exists (check common locations)
if ! command -v python3 &>/dev/null && [ ! -x /opt/homebrew/bin/python3 ] && [ ! -x /usr/local/bin/python3 ]; then
  echo "Error: python3 not found. Install via: xcode-select --install"
  echo "  or: brew install python3"
  exit 1
fi

# Build manifest content
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Web to Figma — invokes Claude Code for Figma capture",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

# Collect candidate NativeMessagingHosts directories for all Chromium browsers
DIRS=()
if [[ "$OSTYPE" == "darwin"* ]]; then
  DIRS+=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
    "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
    "$HOME/Library/Application Support/Dia/User Data/NativeMessagingHosts"
    "$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"
  )
elif [[ "$OSTYPE" == "linux"* ]]; then
  DIRS+=(
    "$HOME/.config/google-chrome/NativeMessagingHosts"
    "$HOME/.config/chromium/NativeMessagingHosts"
    "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    "$HOME/.config/vivaldi/NativeMessagingHosts"
  )
else
  echo "Unsupported OS: $OSTYPE"
  exit 1
fi

INSTALLED=0

for DIR in "${DIRS[@]}"; do
  # Get the parent (browser data dir) — only install if the browser is present
  PARENT="$(dirname "$DIR")"
  if [ -d "$PARENT" ]; then
    mkdir -p "$DIR"
    echo "$MANIFEST" > "$DIR/$HOST_NAME.json"
    echo "  ✓ $(basename "$(dirname "$DIR")")/$(basename "$DIR")"
    INSTALLED=$((INSTALLED + 1))
  fi
done

if [ "$INSTALLED" -eq 0 ]; then
  echo "No supported Chromium browsers detected."
  exit 1
fi

echo ""
echo "Installed manifest for $INSTALLED browser(s)."
echo "  Host: $HOST_SCRIPT"

# Pre-warm Claude to extract native addons without quarantine.
# When browsers spawn Claude via native messaging, macOS quarantine
# blocks the .node addon. Running it once from terminal (no quarantine)
# ensures the addon exists cleanly for future browser-spawned runs.
if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE=$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")
  if [ -x "$CLAUDE" ]; then
    echo ""
    echo "Pre-warming Claude Code (one-time setup)..."
    # Use get_screenshot to force the image processing .node addon to load.
    # A simple prompt won't trigger it — Claude must actually process image data.
    "$CLAUDE" -p "Call get_screenshot for the Figma file at https://www.figma.com/design/placeholder. If it fails, that is fine." \
      --output-format json --max-turns 2 --permission-mode auto \
      --allowedTools "mcp__figma__get_screenshot" > /dev/null 2>&1 || true
    # Clear any quarantine from extracted .node files
    TMPDIR_PATH=$(python3 -c "import tempfile; print(tempfile.gettempdir())" 2>/dev/null || echo "/tmp")
    for f in "$TMPDIR_PATH"/.*.node; do
      [ -f "$f" ] && xattr -d com.apple.quarantine "$f" 2>/dev/null
    done
    echo "  Done."
  fi
fi

echo ""
echo "Reload the extension and click Capture to Figma."
