#!/bin/bash
# Registers the native messaging host for the Web to Figma Chrome extension.
# Run once after loading the unpacked extension.

set -e

HOST_NAME="com.web_to_figma.capture"
HOST_SCRIPT="$(cd "$(dirname "$0")" && pwd)/host.js"

# Detect OS and set manifest directory
if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
elif [[ "$OSTYPE" == "linux"* ]]; then
  MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
else
  echo "Unsupported OS: $OSTYPE"
  exit 1
fi

# Get extension ID
if [ -n "$1" ]; then
  EXT_ID="$1"
else
  echo ""
  echo "Enter your Chrome extension ID (find it at chrome://extensions):"
  read -r EXT_ID
fi

if [ -z "$EXT_ID" ]; then
  echo "Error: Extension ID is required."
  exit 1
fi

# Create manifest directory
mkdir -p "$MANIFEST_DIR"

# Write manifest
cat > "$MANIFEST_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Web to Figma capture host — invokes Claude Code CLI",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo ""
echo "Native messaging host installed:"
echo "  Manifest: $MANIFEST_DIR/$HOST_NAME.json"
echo "  Host:     $HOST_SCRIPT"
echo "  Extension: $EXT_ID"
echo ""
echo "Done. Reload the extension and click Capture to Figma."
