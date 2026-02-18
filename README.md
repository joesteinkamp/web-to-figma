# web-to-figma

A local CLI tool that uses Playwright to open websites in a headed browser, exposing an HTTP API so you can capture any web page to Figma.

## Setup

```bash
npm install
npm run setup  # installs Playwright Chromium
```

## Usage

```bash
npm start
```

This launches a headed Chromium browser and starts a local server on port 3131. Browse to any page in the browser window (or use the `/navigate` endpoint), then capture it to Figma.

### Workflow with Claude Code

1. Start the server: `npm start`
2. Browse to the page you want to capture (click around freely)
3. Ask Claude Code to capture the current page to Figma
4. Claude Code calls `generate_figma_design` to get a `captureId`, then `POST /capture-figma` to run the capture
5. The captured design appears in your Figma account

### API Endpoints

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/status` | — | Current page URL and ready state |
| POST | `/navigate` | `{ "url": "https://..." }` | Open a URL in the browser |
| POST | `/inject` | `{ "script": "..." }` | Run JavaScript in the page |
| POST | `/capture-figma` | `{ "captureId", "endpoint" }` | Capture the current page to Figma |
| POST | `/screenshot` | — | Full-page screenshot as base64 PNG |
| POST | `/close` | — | Shut down browser and server |

### Manual capture via curl

```bash
# Check status
curl http://localhost:3131/status

# Navigate to a page
curl -X POST http://localhost:3131/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'

# Inject JavaScript
curl -X POST http://localhost:3131/inject \
  -H 'Content-Type: application/json' \
  -d '{"script":"document.title"}'
```

## How It Works

- Launches Chromium with `bypassCSP: true` so the Figma capture script can run on any site
- The `/capture-figma` endpoint fetches Figma's capture script via Playwright's API (outside the page context), injects it into the page, and triggers the capture
- Automatically tracks new tabs if you click links that open in a new window
