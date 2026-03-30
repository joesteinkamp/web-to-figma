# Web to Figma — Chrome Extension

One-click capture of any webpage to Figma.

## Prerequisites

- **Claude Code** with the Figma MCP server configured:
  ```
  claude mcp add --transport http figma https://mcp.figma.com/mcp
  ```

## Setup

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select this `chrome-extension/` directory

## Usage

1. Start the capture server (from the project root):
   ```bash
   npm run capture
   ```
2. Navigate to the webpage you want to capture
3. Click the **Web to Figma** extension icon
4. Click **Capture to Figma**

The extension calls the local server, which uses Claude Code's CLI to invoke `generate_figma_design` on Figma's MCP server. This takes ~10 seconds.

## How It Works

1. Extension sends the page title to `localhost:3131/generate-capture`
2. The server runs `claude -p` to call `generate_figma_design` via Figma's MCP
3. Server returns `captureId` + `endpoint` to the extension
4. Extension fetches and injects Figma's capture script into the page
5. Extension calls `captureForDesign()` — the design appears in your Figma drafts
