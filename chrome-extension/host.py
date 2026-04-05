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

def fix_node_quarantine():
    """Ad-hoc codesign .node files in the system temp dir so they pass Gatekeeper.
    Claude Code extracts native addons to temp with a unique name per run.
    When spawned from a browser, these get quarantined. A codesigned file
    passes Gatekeeper even with quarantine. Returns True if any files were signed."""
    if sys.platform != "darwin":
        return False
    import tempfile, glob
    tmpdir = tempfile.gettempdir()
    fixed = False
    for f in glob.glob(os.path.join(tmpdir, ".*.node")):
        try:
            # Ad-hoc codesign — makes the file pass Gatekeeper even with quarantine
            result = subprocess.run(
                ["codesign", "--sign", "-", "--force", f],
                capture_output=True, timeout=10,
            )
            if result.returncode == 0:
                fixed = True
                logging.info("Codesigned %s", f)
        except Exception:
            pass
    return fixed

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
            # Build a description of the page from captured structure
            page_structure = message.get("pageStructure", [])
            page_desc = ""
            if page_structure:
                lines = []
                for el in page_structure[:80]:
                    tag = el.get("tag", "")
                    text = el.get("text", "")[:60]
                    if text:
                        lines.append(f"  <{tag}> {text}")
                page_desc = "\nHere is the actual page structure to recreate:\n" + "\n".join(lines) + "\n\n"

            prompt = (
                f'Build a design in the Figma file at "{file_url}" that recreates the web page titled "{title}" '
                f'using real design system components.{page_desc}'
                "Complete ALL steps.\n\n"
                "Step 1: Call search_design_system to find components in the file's design system libraries. "
                'Run multiple searches with different terms: '
                '"button", "input", "card", "nav", "header", "footer", "avatar", "icon", "tag", "toggle". '
                "Record the component keys, variable keys, and style keys you find.\n\n"
                "Step 2: Call use_figma to build a page in the file that recreates the web page layout "
                "using the real design system components found in step 1. You MUST:\n"
                f'- Pass the file URL "{file_url}" to use_figma\n'
                "- Import components using figma.importComponentSetByKeyAsync(key)\n"
                "- Create instances using component.createInstance()\n"
                "- Import variables using figma.variables.importVariableByKeyAsync(key)\n"
                "- Bind variables using node.setBoundVariable() instead of hardcoding colors/spacing\n"
                "- Use auto layout (layoutMode, primaryAxisAlignItems, counterAxisAlignItems)\n"
                "- Work section by section, one use_figma call per section\n"
                "- Return all created node IDs from each call\n\n"
                'After completing all steps, return {"status": "complete"}.\n\n'
                "If asked to choose an organization or team, select the first one available. "
                "Do not ask for confirmation or clarification. Do not open any URLs in a browser."
            )
            allowed_tools = (
                "mcp__figma__use_figma,"
                "mcp__figma__search_design_system,"
                "mcp__figma__get_metadata,"
                "mcp__figma__get_variable_defs"
            )
            timeout = 600
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
            "--permission-mode", "auto",
            "--max-turns", "20" if use_design_system else "5",
        ]
        if use_design_system:
            system_context = load_skills_context()
            cmd += ["--append-system-prompt", system_context]

        # Prevent Claude from loading native .node addons. When spawned from
        # a browser's native messaging host, macOS quarantine blocks unsigned
        # .node files extracted by Claude's SEA binary, causing Gatekeeper errors.
        # The --no-addons flag tells Node.js to skip native addons entirely.
        env = os.environ.copy()
        env["NODE_OPTIONS"] = "--no-addons"

        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
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

        # Check for auth errors
        text_lower = str(text).lower()
        if any(s in text_lower for s in ["auth", "token expired", "unauthorized", "401", "login", "authenticate"]):
            logging.warning("Auth error detected: %.200s", text)
            send_message({"error": "Figma auth expired. Run 'claude' in your terminal to re-authenticate with Figma."})
            return

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
