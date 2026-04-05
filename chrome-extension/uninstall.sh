#!/bin/bash
# Uninstalls Web to Figma: stops daemon, removes plist, manifests, and installed files.

set -e

echo "Uninstalling Web to Figma..."

# Stop and unload the DS daemon
PLIST="$HOME/Library/LaunchAgents/com.web_to_figma.ds.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  ✓ Stopped DS daemon"
fi

# Remove native messaging manifests from all browsers
HOST_NAME="com.web_to_figma.capture"
DIRS=(
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
  "$HOME/.config/google-chrome/NativeMessagingHosts"
  "$HOME/.config/chromium/NativeMessagingHosts"
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/.config/microsoft-edge/NativeMessagingHosts"
  "$HOME/.config/vivaldi/NativeMessagingHosts"
)

REMOVED=0
for DIR in "${DIRS[@]}"; do
  if [ -f "$DIR/$HOST_NAME.json" ]; then
    rm -f "$DIR/$HOST_NAME.json"
    REMOVED=$((REMOVED + 1))
  fi
done
echo "  ✓ Removed $REMOVED native messaging manifest(s)"

# Remove installed files
if [ -d "$HOME/.web-to-figma" ]; then
  rm -rf "$HOME/.web-to-figma"
  echo "  ✓ Removed ~/.web-to-figma"
fi

# Remove log file
rm -f "$HOME/.web-to-figma-host.log"

echo ""
echo "Done! You can now remove the extension from your browser."
