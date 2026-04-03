# Web to Figma — Chrome Extension

One-click capture of any webpage to Figma.

## Prerequisites

- **Node.js** (to run the native host script)
- **Claude Code** with the Figma MCP server configured:
  ```
  claude mcp add --transport http figma https://mcp.figma.com/mcp
  ```

## Setup

1. Load the extension:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked** → select this `chrome-extension/` directory

2. Click **Capture to Figma** — the extension will show the install command with your extension ID pre-filled. Copy it, run it in your terminal once.

3. Click **Retry** — you're set.

## Usage

1. Navigate to any webpage
2. Click the **Web to Figma** extension icon
3. Click **Capture to Figma** (~10s while Claude Code calls Figma)

## How It Works

1. Extension sends a message via Chrome Native Messaging to `native-host/host.js`
2. The host script runs `claude -p` to call `generate_figma_design` on Figma's MCP
3. Host returns `captureId` + `endpoint` to the extension
4. Extension injects Figma's capture script and calls `captureForDesign()`
5. The design appears in your Figma drafts
