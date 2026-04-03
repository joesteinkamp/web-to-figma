#!/bin/bash
# One-line setup for Web to Figma extension native messaging host.
# Usage: curl -fsSL https://raw.githubusercontent.com/joesteinkamp/web-to-figma/main/setup.sh | bash -s -- <extension-id>

set -e

HOST_NAME="com.web_to_figma.capture"
INSTALL_DIR="$HOME/.web-to-figma"
HOST_URL="https://raw.githubusercontent.com/joesteinkamp/web-to-figma/main/chrome-extension/host.py"

# Get extension ID
EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: bash setup.sh <extension-id>"
  echo "Find your extension ID at chrome://extensions (or equivalent)"
  exit 1
fi

# Verify python3
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 not found."
  exit 1
fi

# Download host script
mkdir -p "$INSTALL_DIR"
echo "Downloading native host..."
curl -fsSL "$HOST_URL" -o "$INSTALL_DIR/host.py"
chmod +x "$INSTALL_DIR/host.py"

# Build manifest
MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Web to Figma — invokes Claude Code for Figma capture",
  "path": "$INSTALL_DIR/host.py",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)

# Install for all detected Chromium browsers
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
  PARENT="$(dirname "$DIR")"
  if [ -d "$PARENT" ]; then
    mkdir -p "$DIR"
    echo "$MANIFEST" > "$DIR/$HOST_NAME.json"
    INSTALLED=$((INSTALLED + 1))
  fi
done

if [ "$INSTALLED" -eq 0 ]; then
  echo "No supported Chromium browsers detected."
  exit 1
fi

echo ""
echo "Done! Installed for $INSTALLED browser(s)."
echo "  Host: $INSTALL_DIR/host.py"
echo ""
echo "Reload the extension and click Capture to Figma."
