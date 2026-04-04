#!/usr/bin/python3
"""Chrome Native Messaging host for Web to Figma."""

import json
import struct
import subprocess
import sys
import re
import os
import logging

LOG_PATH = os.path.expanduser("~/.web-to-figma-host.log")
logging.basicConfig(filename=LOG_PATH, level=logging.DEBUG,
                    format="%(asctime)s %(levelname)s %(message)s")

def read_message():
    header = sys.stdin.buffer.read(4)
    if not header or len(header) < 4:
        return None
    length = struct.unpack('<I', header)[0]
    body = sys.stdin.buffer.read(length)
    return json.loads(body)

def send_message(msg):
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def find_claude():
    """Find claude CLI in common locations."""
    paths = [
        os.path.expanduser("~/.local/bin/claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
    ]
    for p in paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    # Try PATH as fallback
    import shutil
    return shutil.which("claude")

def extract_config(text):
    m = re.search(r'\{[^{}]*"captureId"[^{}]*\}', text)
    if m:
        try:
            parsed = json.loads(m.group())
            if parsed.get("captureId") and parsed.get("endpoint"):
                return parsed
        except json.JSONDecodeError:
            pass
    cid = re.search(r'captureId["\'\s:]+([a-zA-Z0-9_-]+)', text)
    ep = re.search(r'endpoint["\'\s:]+(https?://[^\s"\']+)', text)
    return {
        "captureId": cid.group(1) if cid else None,
        "endpoint": ep.group(1) if ep else None,
    }

def main():
    try:
        logging.info("Host started")
        message = read_message()
        logging.info("Message received: %s", message)
        if not message:
            send_message({"error": "No message received"})
            return

        if message.get("action") != "generate-capture":
            send_message({"error": f"Unknown action: {message.get('action')}"})
            return

        claude = find_claude()
        logging.info("Claude CLI path: %s", claude)
        if not claude:
            send_message({"error": "Claude Code not found. Install from https://claude.ai/code"})
            return

        title = message.get("title", "Web Capture").replace('"', '\\"')
        file_url = message.get("fileUrl", "")
        use_design_system = message.get("useDesignSystem", False)

        if use_design_system and file_url:
            prompt = (
                f'Capture the web page titled "{title}" using design system components. '
                f'Use the Figma file URL "{file_url}" so captures go to that existing file. '
                "Follow this workflow:\n"
                "1. Call generate_figma_design to create a capture into the file as a flat reference.\n"
                "2. Use search_design_system to find matching components, variables, and styles "
                "in the file's libraries. Search for common UI elements: buttons, inputs, cards, "
                "navigation, headers, footers, icons, avatars, toggles, tags, etc.\n"
                "3. Use use_figma to create a new frame in the file that rebuilds the page layout "
                "using real component instances, variable bindings for colors and spacing, and "
                "proper auto layout structure. Work section by section.\n"
                "4. Delete the flat capture reference frame when the component-based version is complete.\n"
                "If asked to choose an organization or team, select the first one available. "
                "Do not ask for confirmation or clarification. "
                "Return ONLY the JSON object containing captureId and endpoint. No other text."
            )
            allowed_tools = (
                "mcp__figma__generate_figma_design,"
                "mcp__figma__get_metadata,"
                "mcp__figma__use_figma,"
                "mcp__figma__search_design_system,"
                "mcp__figma__get_screenshot,"
                "mcp__figma__get_variable_defs"
            )
            timeout = 300
        elif file_url:
            prompt = (
                f'Call the generate_figma_design tool to create a new capture with title "{title}". '
                f'Use the Figma file URL "{file_url}" so the capture is added to that existing file. '
                "If asked to choose an organization or team, select the first one available. "
                "Do not ask for confirmation or clarification. "
                "Return ONLY the JSON object containing captureId and endpoint. No other text."
            )
            allowed_tools = "mcp__figma__generate_figma_design,mcp__figma__get_metadata"
            timeout = 90
        else:
            prompt = (
                f'Call the generate_figma_design tool to create a new capture with title "{title}". '
                "If asked to choose an organization or team, select the first one available. "
                "Do not ask for confirmation or clarification. "
                "Return ONLY the JSON object containing captureId and endpoint. No other text."
            )
            allowed_tools = "mcp__figma__generate_figma_design,mcp__figma__get_metadata"
            timeout = 90

        logging.info("Running: %s -p ... (ds=%s, timeout=%s)", claude, use_design_system, timeout)
        result = subprocess.run(
            [claude, "-p", prompt, "--output-format", "json", "--allowedTools", allowed_tools],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        logging.info("Claude exit code: %s", result.returncode)
        logging.debug("Claude stdout: %.500s", result.stdout)
        if result.stderr:
            logging.debug("Claude stderr: %.500s", result.stderr)

        text = result.stdout
        try:
            envelope = json.loads(text)
            text = envelope.get("result") or envelope.get("content") or text
        except (json.JSONDecodeError, AttributeError):
            pass

        config = extract_config(str(text))
        logging.info("Extracted config: %s", config)

        if config["captureId"] and config["endpoint"]:
            send_message(config)
        else:
            send_message({"error": "Could not get captureId/endpoint. Is Figma MCP configured in Claude Code?"})

    except subprocess.TimeoutExpired:
        logging.error("Timed out waiting for Claude")
        send_message({"error": "Timed out. Try again."})
    except Exception as e:
        logging.exception("Host error")
        send_message({"error": f"Host error: {str(e)}"})

if __name__ == "__main__":
    main()
