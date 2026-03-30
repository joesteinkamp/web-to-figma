# Web to Figma — Chrome Extension

One-click capture of any webpage to Figma.

## Prerequisites

- **Node.js** (to run the native host script)
- **Claude Code** with the Figma MCP server configured:
  ```
  claude mcp add --transport http figma https://mcp.figma.com/mcp
  ```

## Setup (one time)

1. Load the extension:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked** → select this `chrome-extension/` directory
   - Copy your **extension ID** from the card

2. Register the native messaging host:
   ```bash
   ./native-host/install.sh <your-extension-id>
   ```

3. Reload the extension in `chrome://extensions/`

## Usage

1. Navigate to any webpage
2. Click the **Web to Figma** extension icon
3. Click **Capture to Figma**

No server to start. The extension spawns the native host on demand, which calls Claude Code to generate a Figma capture session.

## How It Works

1. Extension sends a message via Chrome Native Messaging to `native-host/host.js`
2. The host script runs `claude -p` to call `generate_figma_design` on Figma's MCP
3. Host returns `captureId` + `endpoint` to the extension
4. Extension injects Figma's capture script and calls `captureForDesign()`
5. The design appears in your Figma drafts
