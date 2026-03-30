# Web to Figma — Chrome Extension

One-click capture of any webpage to Figma. No server, no copy-pasting IDs — just click and go.

## Setup

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select this `chrome-extension/` directory
4. The extension icon appears in your toolbar

## Usage

1. Navigate to the webpage you want to capture
2. Click the **Web to Figma** extension icon
3. Click **Capture to Figma**
4. First time only: sign in to Figma when prompted

The extension connects directly to Figma's remote MCP server (`mcp.figma.com`) to handle capture setup automatically.

## How It Works

1. The extension authenticates with Figma via OAuth (one-time sign-in)
2. On capture, it calls `generate_figma_design` on Figma's remote MCP server to get a capture session
3. It fetches and injects Figma's capture script into the current page (bypasses CSP via `world: "MAIN"`)
4. It calls `window.figma.captureForDesign()` with the session credentials
5. The captured design appears in your Figma drafts
