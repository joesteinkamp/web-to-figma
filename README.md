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

## Headless mode (Vercel agent-browser)

For server / CI / cloud-agent use cases — and especially for capturing pages behind authentication where you need to **pass credentials programmatically** instead of logging in by hand — the same server can run headlessly against [Vercel's agent-browser](https://github.com/vercel-labs/agent-browser) over CDP.

### Prerequisite

Install the `agent-browser` CLI on your `PATH` (e.g. via Homebrew or Cargo). The Node server spawns it per session; no Node SDK is required. Override the binary path with `AGENT_BROWSER_BIN` if needed.

### Run

```bash
npm run start:headless
# or: node server.js --headless
# or: WEB_TO_FIGMA_MODE=headless npm start
```

In headless mode, no default session is created at startup — callers must explicitly create a session so they can pass credentials.

### API surface

The driving endpoints (`/navigate`, `/inject`, `/capture-figma`, `/screenshot`) are unchanged but accept an optional `sessionId`. Two new endpoints manage session lifecycle:

```http
POST /session
Content-Type: application/json

{
  "name":         "stripe-dashboard",            // optional; passed to agent-browser --session-name (cookies + localStorage persist across runs)
  "headers":      { "Authorization": "Bearer …" },// extra HTTP headers applied via setExtraHTTPHeaders
  "cookies":      [ /* Playwright Cookie[] */ ], // applied via context.addCookies
  "storageState": { "cookies": [], "origins": [] }, // full Playwright storageState (cookies + per-origin localStorage)
  "profile":      "/path/to/chrome/profile",      // persistent Chrome profile dir (passed via --profile)
  "statePath":    "/path/to/state.json",          // saved state file (passed via --state)
  "loginUrl":     "https://example.com/dashboard",// optional first navigation after auth setup
  "headed":       false                            // open visibly for one-time interactive auth (headless mode only)
}

→ { "sessionId": "s_abc123", "mode": "headless", "url": "..." }
```

```http
DELETE /session/:id
GET    /sessions
```

All driving requests then include the sessionId:

```http
POST /navigate       { "sessionId": "s_abc123", "url": "..." }
POST /capture-figma  { "sessionId": "s_abc123", "captureId": "...", "endpoint": "..." }
```

### Credential strategies

1. **Bearer / API tokens** → `headers: { "Authorization": "Bearer …" }`
2. **Exported cookies** → `cookies: [ … ]` from a real logged-in browser session
3. **Full storage state** → `storageState: { cookies, origins }` (cookies + per-origin `localStorage`)
4. **Persistent profile** → `profile: "/path/to/profile"` reuses a real Chrome profile directory
5. **Reusable named session** → `name: "stripe-dashboard"`; agent-browser auto-saves and restores cookies/localStorage between server runs
6. **agent-browser vault** → run `agent-browser auth save <name>` once to capture credentials interactively, then create sessions with `name`/`profile` and let agent-browser handle the login

### Backwards compatibility

Headed mode (default `npm start`) is unchanged: a `default` session is auto-created and existing requests without a `sessionId` resolve to it.
