#!/bin/bash
# Tests the native messaging host by sending a properly formatted message
# and checking if it responds correctly.
#
# Usage: ./test-native-host.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$SCRIPT_DIR/host-wrapper.sh"
HOST="$SCRIPT_DIR/host.js"

echo "=== Native Messaging Host Test ==="
echo ""

# 1. Check files exist
echo "1. Checking files..."
for f in "$WRAPPER" "$HOST"; do
  if [ -f "$f" ]; then
    echo "   ✓ $(basename $f) exists"
    if [ -x "$f" ]; then
      echo "   ✓ $(basename $f) is executable"
    else
      echo "   ✗ $(basename $f) is NOT executable"
      echo "   Fix: chmod +x $f"
      exit 1
    fi
  else
    echo "   ✗ $(basename $f) MISSING"
    echo "   Run install.sh first"
    exit 1
  fi
done

# 2. Check manifest
echo ""
echo "2. Checking Chrome manifest..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.web_to_figma.capture.json"
elif [[ "$OSTYPE" == "linux"* ]]; then
  MANIFEST="$HOME/.config/google-chrome/NativeMessagingHosts/com.web_to_figma.capture.json"
fi

if [ -f "$MANIFEST" ]; then
  echo "   ✓ Manifest exists"
  MANIFEST_PATH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).path)")
  echo "   Path in manifest: $MANIFEST_PATH"
  if [ -x "$MANIFEST_PATH" ]; then
    echo "   ✓ Path is executable"
  else
    echo "   ✗ Path is NOT executable or doesn't exist"
    exit 1
  fi
else
  echo "   ✗ Manifest MISSING"
  echo "   Run install.sh first"
  exit 1
fi

# 3. Test: can the wrapper start node?
echo ""
echo "3. Testing wrapper starts node..."
RESULT=$(echo "" | timeout 5 "$WRAPPER" 2>&1 || true)
if echo "$RESULT" | grep -q "error\|crash\|Error"; then
  echo "   ✓ Wrapper runs, host.js loaded (got expected error for empty input)"
  echo "   Response: $RESULT"
else
  echo "   ? Wrapper output: $RESULT"
fi

# 4. Test: send a properly formatted native messaging message
echo ""
echo "4. Sending test message in native messaging format..."
RESPONSE=$(node -e "
const { execFileSync } = require('child_process');
const msg = Buffer.from(JSON.stringify({action: 'test-echo'}));
const header = Buffer.alloc(4);
header.writeUInt32LE(msg.length, 0);
const stdin = Buffer.concat([header, msg]);

const result = require('child_process').spawnSync('$WRAPPER', [], {
  input: stdin,
  timeout: 10000
});

const stdout = result.stdout;
const stderr = result.stderr ? result.stderr.toString() : '';

if (stdout && stdout.length >= 4) {
  const respLen = stdout.readUInt32LE(0);
  const respBody = stdout.slice(4, 4 + respLen).toString();
  console.log('OK: ' + respBody);
} else {
  console.log('NO RESPONSE (exit code: ' + result.status + ')');
  if (stderr) console.log('STDERR: ' + stderr);
}
" 2>&1)

echo "   $RESPONSE"

# 5. Test: send actual generate-capture message (will call claude)
echo ""
echo "5. To test the full flow (calls claude -p, takes ~10s):"
echo "   Run: ./test-native-host.sh --full"
echo ""

if [ "$1" = "--full" ]; then
  echo "   Sending generate-capture message..."
  RESPONSE=$(node -e "
const msg = Buffer.from(JSON.stringify({action: 'generate-capture', title: 'Test Capture'}));
const header = Buffer.alloc(4);
header.writeUInt32LE(msg.length, 0);
const stdin = Buffer.concat([header, msg]);

const result = require('child_process').spawnSync('$WRAPPER', [], {
  input: stdin,
  timeout: 90000
});

const stdout = result.stdout;
const stderr = result.stderr ? result.stderr.toString() : '';

if (stdout && stdout.length >= 4) {
  const respLen = stdout.readUInt32LE(0);
  const respBody = stdout.slice(4, 4 + respLen).toString();
  console.log('Response: ' + respBody);
} else {
  console.log('NO RESPONSE (exit code: ' + result.status + ')');
  if (stderr) console.log('STDERR: ' + stderr);
}
" 2>&1)
  echo "   $RESPONSE"
fi

echo "=== Done ==="
