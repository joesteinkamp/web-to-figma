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

def clear_quarantine():
    """On macOS, remove quarantine flags that block native .node addons
    when spawned from Chrome's native messaging host."""
    if sys.platform != "darwin":
        return
    paths = [
        os.path.expanduser("~/.claude"),
        os.path.expanduser("~/.local/bin"),
        os.path.expanduser("~/.local/lib/node_modules"),
        os.path.expanduser("~/.npm"),
        os.path.expanduser("~/.nvm"),
    ]
    for p in paths:
        if os.path.exists(p):
            try:
                subprocess.run(
                    ["xattr", "-rd", "com.apple.quarantine", p],
                    capture_output=True, timeout=10,
                )
            except Exception:
                pass

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
    if cid and ep:
        return {"captureId": cid.group(1), "endpoint": ep.group(1)}
    # Fallback: extract from figmacapture URL format
    # e.g. #figmacapture=UUID&figmaendpoint=URL_ENCODED
    fc = re.search(r'figmacapture=([a-zA-Z0-9_-]+)', text)
    fe = re.search(r'figmaendpoint=(https?[^\s&"\']+)', text)
    if fc and fe:
        from urllib.parse import unquote
        return {"captureId": fc.group(1), "endpoint": unquote(fe.group(1))}
    return {
        "captureId": cid.group(1) if cid else None,
        "endpoint": ep.group(1) if ep else None,
    }

def main():
    try:
        logging.info("Host started")
        clear_quarantine()
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
                f'You MUST complete ALL of the following steps in order. Do not stop after step 1.\n\n'
                f'Step 1: Call generate_figma_design with title "{title}" and pass the file_url parameter '
                f'set to "{file_url}". Save the captureId and endpoint from the response.\n\n'
                f'Step 2: Call search_design_system to find components in the file\'s design system libraries. '
                f'Pass the file URL "{file_url}" as context. Run multiple searches with different terms: '
                '"button", "input", "card", "nav", "header", "footer", "avatar", "icon", "tag", "toggle". '
                "Record the component keys, variable keys, and style keys you find.\n\n"
                "Step 3: Call use_figma to build a new page in the file that recreates the captured page "
                "using the real design system components found in step 2. You MUST:\n"
                f'- Pass the file URL "{file_url}" to use_figma\n'
                "- Import components using figma.importComponentSetByKeyAsync(key)\n"
                "- Create instances using component.createInstance()\n"
                "- Import variables using figma.variables.importVariableByKeyAsync(key)\n"
                "- Bind variables using node.setBoundVariable() instead of hardcoding colors/spacing\n"
                "- Use auto layout (layoutMode, primaryAxisAlignItems, counterAxisAlignItems)\n"
                "- Work section by section, one use_figma call per section\n"
                "- Return all created node IDs from each call\n\n"
                "Step 4: After building all sections with components, delete the original flat capture frame.\n\n"
                "After completing ALL four steps, return the captureId and endpoint from step 1 as JSON: "
                '{"captureId": "...", "endpoint": "..."}\n\n'
                "If asked to choose an organization or team, select the first one available. "
                "Do not ask for confirmation or clarification. Do not open any URLs in a browser."
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
                f'Call the generate_figma_design tool with title "{title}" '
                f'and pass the file_url parameter set to "{file_url}" '
                "so the capture goes into that existing file instead of creating a new one. "
                "If asked to choose an organization or team, select the first one available. "
                "Do not ask for confirmation or clarification. Do not open any URLs in a browser. "
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
