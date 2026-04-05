#!/usr/bin/python3
"""Background HTTP server for Web to Figma design system mode.
Runs as a launchd user agent to avoid browser quarantine context.

When browsers spawn processes via native messaging, macOS Gatekeeper
blocks unsigned native addons (.node files) that Claude Code extracts.
This daemon runs outside the browser's process tree, so no quarantine."""

from http.server import HTTPServer, BaseHTTPRequestHandler
import json
import subprocess
import os
import sys
import re
import logging
import shutil
import threading
import uuid

PORT = 19615
LOG_PATH = os.path.expanduser("~/.web-to-figma/daemon.log")

# Job tracking — DS captures run in background threads
current_job = {"id": None, "status": "idle", "result": None}

logging.basicConfig(
    filename=LOG_PATH, level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(message)s",
)


def find_claude():
    paths = [
        os.path.expanduser("~/.local/bin/claude"),
        "/usr/local/bin/claude",
        "/opt/homebrew/bin/claude",
    ]
    for p in paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which("claude")


def load_skills_context():
    skills_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")
    files = [
        "figma-use/SKILL.md",
        "figma-generate-design/SKILL.md",
    ]
    parts = []
    for f in files:
        path = os.path.join(skills_dir, f)
        if os.path.isfile(path):
            with open(path) as fh:
                parts.append(f"--- {f} ---\n{fh.read()}")
    return "\n\n".join(parts)


def run_ds_capture(msg):
    claude = find_claude()
    if not claude:
        return {"error": "Claude Code not found. Install from https://claude.ai/code"}

    title = msg.get("title", "Web Capture").replace('"', '\\"')
    file_url = msg.get("fileUrl", "")
    if not file_url:
        return {"error": "fileUrl is required for design system mode"}

    page_structure = msg.get("pageStructure", [])
    page_desc = ""
    if page_structure:
        lines = []
        for el in page_structure[:50]:
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
        "mcp__figma__get_screenshot,"
        "mcp__figma__get_variable_defs"
    )

    system_context = load_skills_context()

    cmd = [
        claude, "-p", prompt,
        "--output-format", "json",
        "--allowedTools", allowed_tools,
        "--permission-mode", "auto",
        "--max-turns", "40",
        "--append-system-prompt", system_context,
    ]

    logging.info("Running Claude for DS capture (title=%s)", title)
    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=600,
        )
        logging.info("Claude exit code: %s", result.returncode)
        logging.debug("Claude stdout: %.500s", result.stdout)

        text = result.stdout
        try:
            envelope = json.loads(text)
            text = envelope.get("result") or envelope.get("content") or text
        except (json.JSONDecodeError, AttributeError):
            pass

        text_lower = str(text).lower()
        if any(s in text_lower for s in ["auth", "token expired", "unauthorized", "401", "login", "authenticate"]):
            return {"error": "Figma auth expired. Run 'claude' in your terminal to re-authenticate with Figma."}

        logging.info("DS capture complete")
        return {"status": "complete"}

    except subprocess.TimeoutExpired:
        logging.error("Timed out")
        return {"error": "Timed out (10 min). Try again."}
    except Exception as e:
        logging.exception("DS capture error")
        return {"error": f"Error: {str(e)}"}


def do_uninstall():
    """Clean up daemon, plist, and installed files."""
    import signal
    home = os.path.expanduser("~")
    plist = os.path.join(home, "Library/LaunchAgents/com.web_to_figma.ds.plist")

    # Unload launchd job
    subprocess.run(["launchctl", "unload", plist], capture_output=True)

    # Remove plist
    try:
        os.unlink(plist)
    except OSError:
        pass

    # Remove native messaging manifests
    nm_dirs = [
        "Google/Chrome", "Chromium", "BraveSoftware/Brave-Browser",
        "Microsoft Edge", "Vivaldi", "Arc/User Data",
        "Dia/User Data", "com.operasoftware.Opera",
    ]
    for d in nm_dirs:
        path = os.path.join(home, "Library/Application Support", d, "NativeMessagingHosts/com.web_to_figma.capture.json")
        try:
            os.unlink(path)
        except OSError:
            pass

    # Remove install dir (deferred — let the process exit first)
    install_dir = os.path.expanduser("~/.web-to-figma")
    logging.info("Uninstall complete. Files at %s can be manually removed.", install_dir)

    # Stop ourselves
    os.kill(os.getpid(), signal.SIGTERM)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._send_json({"status": "ok"})
        elif self.path == "/status":
            self._send_json({
                "id": current_job["id"],
                "status": current_job["status"],
                "result": current_job["result"],
            })
        elif self.path == "/uninstall":
            self._send_html(
                "<html><body><h2>Web to Figma uninstalled</h2>"
                "<p>Background service stopped. Native messaging hosts removed.</p>"
                "<p>You can close this tab.</p></body></html>"
            )
            threading.Timer(1.0, do_uninstall).start()
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/ds-capture":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}

            # If a job is already running, reject
            if current_job["status"] == "running":
                self._send_json({"error": "A capture is already in progress"})
                return

            # Start job in background thread, return immediately
            job_id = str(uuid.uuid4())[:8]
            current_job["id"] = job_id
            current_job["status"] = "running"
            current_job["result"] = None
            logging.info("DS capture started: job=%s title=%s", job_id, body.get("title"))

            def worker():
                result = run_ds_capture(body)
                current_job["status"] = "complete"
                current_job["result"] = result
                logging.info("DS capture finished: job=%s", job_id)

            threading.Thread(target=worker, daemon=True).start()
            self._send_json({"id": job_id, "status": "running"})
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def _send_json(self, data):
        body = json.dumps(data).encode()
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, format, *args):
        logging.debug(format, *args)


if __name__ == "__main__":
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    logging.info("DS daemon started on port %d", PORT)
    print(f"Web to Figma DS daemon running on http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logging.info("Daemon stopped")
        server.shutdown()
