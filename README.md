# web-to-figma

A CLI tool for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) that uses Playwright to open websites in a headed browser, exposing an HTTP API so Claude can capture any web page to Figma. It works in conjunction with [Figma's MCP server](https://github.com/figma/figma-mcp) which provides the `generate_figma_design` tool that handles capture ID generation and Figma file creation.

## Prerequisites

1. **Claude Code** — This tool is designed to work with Claude Code. Install it from [claude.ai/claude-code](https://claude.ai/claude-code).

2. **Figma MCP server** — You must add the Figma MCP server to your Claude Code configuration. Add the following to your `~/.claude/settings.json`:

   ```json
   {
     "mcpServers": {
       "figma": {
         "command": "npx",
         "args": ["-y", "figma-developer-mcp", "--stdio"]
       }
     }
   }
   ```

   Then authenticate with Figma by following the prompts when Claude Code starts.

## Setup

```bash
npm install
npm run setup  # installs Playwright Chromium
```

## Usage

1. Start the server:
   ```bash
   npm start
   ```
2. A browser window will open. Tell Claude Code what to do:

   - `"navigate to stripe.com and capture it to figma"`
   - `"capture this page to figma"`
   - `"start the server"` (if you haven't already)

   You can also browse to any page manually in the browser window, then ask Claude to capture it.

## How It Works

1. This tool launches a headed Chromium browser and a local Express server
2. You browse to the page you want to capture (or use `/navigate`)
3. Claude Code calls Figma's MCP `generate_figma_design` tool to get a `captureId` and submission endpoint
4. Claude Code calls `/capture-figma` which fetches Figma's capture script via Playwright's API (bypassing page CSP), injects it into the page, and triggers the capture
5. Claude Code polls `generate_figma_design` with the `captureId` to get the resulting Figma file URL

The browser launches with `bypassCSP: true` so the Figma capture script can run on any site without Content Security Policy restrictions. New tabs are automatically tracked if you click links that open in a new window.
