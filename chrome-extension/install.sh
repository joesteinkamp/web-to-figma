#!/bin/bash
# Registers the native messaging host and DS daemon for the Web to Figma extension.
# Installs for all detected Chromium-based browsers.

set -e

HOST_NAME="com.web_to_figma.capture"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.web-to-figma"

# Copy all files to a stable location outside the repo.
# Some browsers (e.g. Dia) cannot exec scripts from certain directories.
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/host-wrapper.sh" "$INSTALL_DIR/host-wrapper.sh"
cp "$SCRIPT_DIR/host.py" "$INSTALL_DIR/host.py"
cp "$SCRIPT_DIR/ds-daemon.py" "$INSTALL_DIR/ds-daemon.py"
cp -r "$SCRIPT_DIR/skills" "$INSTALL_DIR/skills" 2>/dev/null || true
chmod +x "$INSTALL_DIR/host-wrapper.sh" "$INSTALL_DIR/ds-daemon.py"
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

# --- Check prerequisites ---

# Find python3
PYTHON=""
for p in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  [ -x "$p" ] && PYTHON="$p" && break
done
if [ -z "$PYTHON" ]; then
  PYTHON=$(command -v python3 2>/dev/null || true)
fi
if [ -z "$PYTHON" ]; then
  echo "Error: python3 not found. Install via: xcode-select --install"
  echo "  or: brew install python3"
  exit 1
fi
echo "  ✓ Python 3 found ($PYTHON)"

# Claude Code CLI
CLAUDE_CMD=$(command -v claude 2>/dev/null || true)
if [ -z "$CLAUDE_CMD" ]; then
  echo ""
  echo "Claude Code CLI not found."
  echo "Install it with:  npm install -g @anthropic-ai/claude-code"
  echo "  More info: https://docs.anthropic.com/en/docs/claude-code"
  echo ""
  read -r -p "Continue anyway? (y/N) " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    exit 1
  fi
else
  echo "  ✓ Claude Code found ($CLAUDE_CMD)"
fi

# Figma MCP server
SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ] && grep -q "figma" "$SETTINGS_FILE" 2>/dev/null; then
  echo "  ✓ Figma MCP server configured"
else
  echo ""
  echo "Figma MCP server not found in Claude Code settings."
  echo "Add this to $SETTINGS_FILE:"
  echo ""
  echo '  {
    "mcpServers": {
      "figma": {
        "command": "npx",
        "args": ["-y", "figma-developer-mcp", "--stdio"]
      }
    }
  }'
  echo ""
  echo "Then restart Claude Code and follow the Figma auth prompts."
  echo ""
  read -r -p "Continue anyway? (y/N) " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# --- Native messaging manifests (for regular capture mode) ---

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
    echo "  ✓ $(basename "$(dirname "$DIR")")/$(basename "$DIR")"
    INSTALLED=$((INSTALLED + 1))
  fi
done

if [ "$INSTALLED" -eq 0 ]; then
  echo "No supported Chromium browsers detected."
  exit 1
fi

echo ""
echo "Installed native messaging for $INSTALLED browser(s)."

# --- DS daemon (macOS only — launchd user agent) ---

if [[ "$OSTYPE" == "darwin"* ]]; then
  PLIST_NAME="com.web_to_figma.ds"
  PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

  # Unload existing daemon if running
  launchctl unload "$PLIST_DEST" 2>/dev/null || true

  # Generate plist with correct paths
  sed \
    -e "s|__PYTHON_PATH__|$PYTHON|g" \
    -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    "$SCRIPT_DIR/com.web_to_figma.ds.plist" > "$PLIST_DEST"

  # Load daemon
  launchctl load "$PLIST_DEST"
  echo "  ✓ DS daemon started (localhost:19615)"
fi

echo ""
echo "Done! Go back to the extension and click Retry."
