# Web to Figma — Chrome Extension

One-click capture of any webpage to Figma.

## Prerequisites

- **Python 3** (to run the native messaging host script)
- **Node.js** (required by Claude Code CLI)
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

1. Extension sends a message via Chrome Native Messaging to `host.py`
2. The host script runs `claude -p` to call `generate_figma_design` on Figma's MCP
3. Host returns `captureId` + `endpoint` to the extension
4. Extension injects Figma's capture script and calls `captureForDesign()`
5. The design appears in your Figma drafts

## Architecture: Why Python for the Native Host?

The native messaging host (`host.py`) is written in Python rather than Node.js, despite Node.js already being a dependency via Claude Code CLI. This is intentional.

Chrome spawns native messaging hosts in a **heavily restricted environment**:

- **Stripped PATH**: Chrome does not source `~/.bashrc`, `~/.zshrc`, or shell profiles. Tools installed via nvm, volta, fnm, or Homebrew are not on the PATH. Finding the `node` binary reliably across macOS install methods (Homebrew Intel vs ARM, nvm, volta, fnm, direct installer) requires complex path probing in the shell wrapper.

- **macOS Gatekeeper quarantine**: When Chrome launches a subprocess, macOS applies stricter Gatekeeper enforcement than Terminal. Native `.node` addons (binary modules used by Claude Code CLI and its dependencies) get blocked with "Native host has exited" errors, even when they run fine from Terminal. Clearing quarantine flags (`xattr -d com.apple.quarantine`) at install time is not sufficient — new `.node` files can appear in temp directories at runtime.

- **Python avoids both problems**: `/usr/bin/python3` (or a Homebrew python3) is a single stable binary with no native addon ecosystem. It doesn't suffer from Gatekeeper issues because it has no `.node` files to block.

A Node.js migration was attempted and reverted (PRs #36, #37). The `host.js` file is kept as a reference implementation but `host.py` is the production host.
