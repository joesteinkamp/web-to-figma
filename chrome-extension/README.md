# Web to Figma — Chrome Extension

A Chrome Extension that captures the current webpage and sends it to a Figma file using Figma's capture script.

## Setup

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked** and select this `chrome-extension/` directory
4. The extension icon appears in your toolbar

## Usage

1. Navigate to the webpage you want to capture
2. Click the **Web to Figma** extension icon
3. Enter the **Capture ID** and **Endpoint** from Figma's MCP server
4. Click **Capture to Figma**

### Getting Capture ID and Endpoint

Use Claude Code with the [Figma MCP server](https://github.com/figma/figma-mcp) configured. Ask Claude to call the `generate_figma_design` tool, which returns the `captureId` and submission `endpoint` needed for the extension.

## How It Works

1. The extension fetches Figma's capture script from `https://mcp.figma.com/mcp/html-to-design/capture.js`
2. It injects the script into the current page using `chrome.scripting.executeScript` (bypasses CSP)
3. It calls `window.figma.captureForDesign()` with the provided captureId and endpoint
4. The captured design is submitted to Figma and appears in your Figma file
