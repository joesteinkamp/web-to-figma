#!/bin/bash
# One-line setup for Web to Figma Chrome extension native messaging host.
# Usage: curl -fsSL https://raw.githubusercontent.com/joesteinkamp/web-to-figma/main/setup.sh | bash -s -- <extension-id>

set -e

HOST_NAME="com.web_to_figma.capture"
INSTALL_DIR="$HOME/.web-to-figma"
HOST_URL="https://raw.githubusercontent.com/joesteinkamp/web-to-figma/main/chrome-extension/host.js"

# Get extension ID
EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: bash setup.sh <chrome-extension-id>"
  echo "Find your extension ID at chrome://extensions"
  exit 1
fi

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
  echo "Unsupported OS: $OSTYPE"
  exit 1
fi

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$MANIFEST_DIR"

# Download host script
echo "Downloading native host..."
curl -fsSL "$HOST_URL" -o "$INSTALL_DIR/host.js"
chmod +x "$INSTALL_DIR/host.js"

# Write manifest
cat > "$MANIFEST_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Web to Figma — invokes Claude Code CLI for Figma capture",
  "path": "$INSTALL_DIR/host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo ""
echo "Done! Native host installed to $INSTALL_DIR/host.js"
echo "Reload the extension and click Capture to Figma."
