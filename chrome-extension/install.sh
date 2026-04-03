#!/bin/bash
# Registers the native messaging host for the Web to Figma Chrome extension.
# Run once after loading the unpacked extension.

set -e

HOST_NAME="com.web_to_figma.capture"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# Find node
NODE_PATH="$(which node 2>/dev/null || echo "")"
if [ -z "$NODE_PATH" ]; then
  for p in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then NODE_PATH="$p"; break; fi
  done
fi
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found. Install Node.js first."
  exit 1
fi

# Create wrapper script (ensures node + claude are found by Chrome)
WRAPPER="$SCRIPT_DIR/host-wrapper.sh"
cat > "$WRAPPER" <<WRAPPER_EOF
#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:\$HOME/.local/bin:\$PATH"
exec "$NODE_PATH" "$SCRIPT_DIR/host.js" "\$@"
WRAPPER_EOF
chmod +x "$WRAPPER"

# Create manifest directory
mkdir -p "$MANIFEST_DIR"

# Write manifest (points to wrapper, not host.js directly)
cat > "$MANIFEST_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Web to Figma capture host — invokes Claude Code CLI",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo ""
echo "Done!"
echo "  Node:      $NODE_PATH"
echo "  Host:      $SCRIPT_DIR/host.js"
echo "  Manifest:  $MANIFEST_DIR/$HOST_NAME.json"
echo ""
echo "Reload the extension and click Capture to Figma."
