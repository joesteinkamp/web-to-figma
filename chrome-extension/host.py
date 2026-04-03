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
        prompt = (
            f'Call the generate_figma_design tool to create a new capture with title "{title}". '
            "If asked to choose an organization or team, select the first one available. "
            "Do not ask for confirmation or clarification. "
            "Return ONLY the JSON object containing captureId and endpoint. No other text."
        )

        logging.info("Running: %s -p ...", claude)
        result = subprocess.run(
            [claude, "-p", prompt, "--output-format", "json", "--allowedTools", "mcp__figma__generate_figma_design,mcp__figma__get_metadata"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=90,
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
        send_message({"error": "Timed out (90s). Try again."})
    except Exception as e:
        logging.exception("Host error")
        send_message({"error": f"Host error: {str(e)}"})

if __name__ == "__main__":
    main()
