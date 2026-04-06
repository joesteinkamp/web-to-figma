#!/usr/bin/python3
"""Chrome Native Messaging host for Web to Figma.
Handles regular capture, file URL modes, and config persistence.
Design system mode is handled by the DS daemon (ds-daemon.py)."""

import json
import struct
import subprocess
import sys
import re
import os
import logging

# Allow importing providers.py from the same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import providers

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
    fc = re.search(r'figmacapture=([a-zA-Z0-9_-]+)', text)
    fe = re.search(r'figmaendpoint=(https?[^\s&"\']+)', text)
    if fc and fe:
        from urllib.parse import unquote
        return {"captureId": fc.group(1), "endpoint": unquote(fe.group(1))}
    return {
        "captureId": cid.group(1) if cid else None,
        "endpoint": ep.group(1) if ep else None,
    }

def handle_set_config(message):
    """Write provider preference to config file."""
    provider = message.get("provider", "auto")
    if provider not in ("auto", "claude", "codex"):
        send_message({"error": f"Invalid provider: {provider}"})
        return
    providers.write_config(provider)
    # Return the resolved provider so the UI can show what was detected
    resolved = providers.read_config_provider()
    send_message({"ok": True, "resolved": resolved})

def handle_detect_provider(message):
    """Return the current provider configuration and detection results."""
    resolved = providers.read_config_provider()
    # Read raw preference
    try:
        with open(providers.CONFIG_PATH) as f:
            pref = json.load(f).get("provider", "auto")
    except (OSError, json.JSONDecodeError):
        pref = "auto"
    send_message({
        "provider": pref,
        "resolved": resolved,
        "claudeInstalled": providers.find_binary("claude") is not None,
        "codexInstalled": providers.find_binary("codex") is not None,
    })

def handle_generate_capture(message):
    """Run the AI CLI to generate a Figma capture."""
    provider = providers.read_config_provider()
    logging.info("Resolved provider: %s", provider)
    if not provider:
        send_message({
            "error": "No AI coding tool found. Install Claude Code (https://claude.ai/code) or Codex (https://github.com/openai/codex)."
        })
        return

    binary = providers.find_binary(provider)
    display_name = providers.provider_display_name(provider)
    logging.info("%s binary path: %s", display_name, binary)

    title = message.get("title", "Web Capture").replace('"', '\\"')
    file_url = message.get("fileUrl", "")

    if file_url:
        prompt = (
            f'Call the generate_figma_design tool with title "{title}" '
            f'and pass the file_url parameter set to "{file_url}" '
            "so the capture goes into that existing file instead of creating a new one. "
            "If asked to choose an organization or team, select the first one available. "
            "Do not ask for confirmation or clarification. Do not open any URLs in a browser. "
            "Return ONLY the JSON object containing captureId and endpoint. No other text."
        )
    else:
        prompt = (
            f'Call the generate_figma_design tool to create a new capture with title "{title}". '
            "If asked to choose an organization or team, select the first one available. "
            "Do not ask for confirmation or clarification. "
            "Return ONLY the JSON object containing captureId and endpoint. No other text."
        )

    allowed_tools = "mcp__figma__generate_figma_design,mcp__figma__get_metadata"

    cmd = providers.build_command(
        provider, binary, prompt,
        allowed_tools=allowed_tools,
        max_turns=5,
    )

    logging.info("Running command: %s", " ".join(cmd[:5]) + " ...")
    result = subprocess.run(
        cmd,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=90,
    )
    logging.info("%s exit code: %s", display_name, result.returncode)
    logging.debug("%s stdout (full): %s", display_name, result.stdout)
    if result.stderr:
        logging.debug("%s stderr: %.1000s", display_name, result.stderr)

    text = providers.parse_output(provider, result.stdout)
    logging.debug("Parsed output: %s", text)

    # Check for auth errors
    text_lower = str(text).lower()
    if any(s in text_lower for s in ["auth", "token expired", "unauthorized", "401", "login", "authenticate"]):
        logging.warning("Auth error detected: %.200s", text)
        send_message({"error": f"Figma auth expired. Run '{provider}' in your terminal to re-authenticate with Figma."})
        return

    config = extract_config(str(text))
    logging.info("Extracted config: %s", config)

    if config["captureId"] and config["endpoint"]:
        send_message(config)
    else:
        send_message({"error": f"Could not get captureId/endpoint. Is Figma MCP configured in {display_name}?"})

def main():
    try:
        logging.info("Host started")
        message = read_message()
        logging.info("Message received: %s", message)
        if not message:
            send_message({"error": "No message received"})
            return

        action = message.get("action")

        if action == "set-config":
            handle_set_config(message)
        elif action == "detect-provider":
            handle_detect_provider(message)
        elif action == "generate-capture":
            handle_generate_capture(message)
        else:
            send_message({"error": f"Unknown action: {action}"})

    except subprocess.TimeoutExpired:
        logging.error("Timed out waiting for AI CLI")
        send_message({"error": "Timed out. Try again."})
    except Exception as e:
        logging.exception("Host error")
        send_message({"error": f"Host error: {str(e)}"})

if __name__ == "__main__":
    main()
