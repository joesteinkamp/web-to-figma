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

def clear_node_quarantine():
    """Clear macOS quarantine from .node files in the system temp dir.
    Returns True if any files were cleared."""
    if sys.platform != "darwin":
        return False
    import tempfile, glob
    tmpdir = tempfile.gettempdir()
    cleared = False
    for f in glob.glob(os.path.join(tmpdir, ".*.node")):
        try:
            result = subprocess.run(
                ["xattr", "-l", f], capture_output=True, text=True, timeout=5,
            )
            if "com.apple.quarantine" in result.stdout:
                subprocess.run(
                    ["xattr", "-d", "com.apple.quarantine", f],
                    capture_output=True, timeout=5,
                )
                cleared = True
                logging.info("Cleared quarantine from %s", f)
        except Exception:
            pass
    return cleared

def load_skills_context():
    """Load Figma skill reference docs for design system mode."""
    skills_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")
    files = [
        "figma-use/SKILL.md",
        "figma-generate-design/SKILL.md",
        "figma-use/references/gotchas.md",
        "figma-use/references/common-patterns.md",
        "figma-use/references/variable-patterns.md",
        "figma-use/references/component-patterns.md",
        "figma-use/references/validation-and-recovery.md",
    ]
    parts = []
    for f in files:
        path = os.path.join(skills_dir, f)
        if os.path.isfile(path):
            with open(path) as fh:
                parts.append(f"--- {f} ---\n{fh.read()}")
    return "\n\n".join(parts)

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
                f'Build a simple layout in the Figma file at "{file_url}" inspired by '
                f'the web page titled "{title}".\n\n'
                "Do this in exactly 3 steps, no more:\n"
                "1. Call search_design_system once with query \"button card input nav\" "
                "to find available components. Note the component keys.\n"
                "2. Call use_figma once to create a frame and add instances of the most "
                "relevant components found. Import components by key using "
                "figma.importComponentSetByKeyAsync(key), create instances, and arrange "
                "them in a vertical auto-layout frame. Return all created node IDs.\n"
                "3. Return {\"status\": \"complete\"} when done.\n\n"
                "Keep it simple — just demonstrate using the design system components. "
                "Do not search multiple times. Do not validate with screenshots. "
                "Do not ask for confirmation. Do not open URLs in a browser. "
                "If asked to choose an organization or team, select the first one available."
            )
            allowed_tools = (
                "mcp__figma__use_figma,"
                "mcp__figma__search_design_system"
            )
            system_context = load_skills_context()
            timeout = 120
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
        cmd = [
            claude, "-p", prompt,
            "--output-format", "json",
            "--allowedTools", allowed_tools,
            "--disallowedTools", "Bash,Read,Write,Edit,Glob,Grep,Agent",
        ]
        if use_design_system and system_context:
            cmd += ["--append-system-prompt", system_context]

        # Clear any quarantined .node files before running Claude
        clear_node_quarantine()

        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        # If Claude failed and there are newly quarantined .node files, clear and retry
        if result.returncode != 0 and clear_node_quarantine():
            logging.info("Retrying after clearing quarantine from .node files")
            result = subprocess.run(
                cmd,
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

        if use_design_system:
            # DS mode: no captureId needed — work was done via MCP tools
            logging.info("DS mode complete. Result: %.200s", text)
            send_message({"status": "complete"})
        else:
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
