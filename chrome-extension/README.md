# Web to Figma — Chrome Extension

One-click capture of any webpage to Figma. Install from the Chrome Web Store, sign in to Figma, and capture.

## For End Users

1. Install the extension from the Chrome Web Store
2. Click the extension icon on any webpage
3. First time: sign in to Figma when prompted
4. Click **Capture to Figma**

## For Developers (Publishing)

Before publishing to the Chrome Web Store, you need to register a Figma OAuth app:

1. Go to [figma.com/developers/apps](https://www.figma.com/developers/apps)
2. Create a new OAuth app
3. Set the redirect URI to: `https://<your-extension-id>.chromiumapp.org/`
   - For development, find your extension ID at `chrome://extensions/`
   - For production, this is your Chrome Web Store extension ID
4. Copy the **Client ID**
5. Paste it into `background.js` as the `FIGMA_CLIENT_ID` value

### Scopes

The app needs these Figma OAuth scopes:
- `file_content:read`
- `file_dev_resources:write`

### How It Works

1. User clicks **Capture to Figma**
2. Extension authenticates with Figma via OAuth 2.0 + PKCE (no client secret needed)
3. Extension calls `generate_figma_design` on Figma's remote MCP server (`mcp.figma.com/mcp`)
4. MCP returns a `captureId` + `endpoint`
5. Extension injects Figma's capture script into the page and calls `captureForDesign()`
6. The design appears in the user's Figma drafts
