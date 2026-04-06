"""Provider abstraction for AI coding CLIs (Claude Code, Codex).

Used by host.py and ds-daemon.py to support multiple AI providers
for invoking Figma MCP tools."""

import json
import os
import shutil
import logging

CONFIG_PATH = os.path.expanduser("~/.web-to-figma/config.json")

CLAUDE_PATHS = [
    os.path.expanduser("~/.local/bin/claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
]

CODEX_PATHS = [
    os.path.expanduser("~/.local/bin/codex"),
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
]


def _find_in_paths(paths, name):
    """Search known paths then fall back to $PATH."""
    for p in paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which(name)


def find_binary(provider):
    """Find the CLI binary for the given provider ('claude' or 'codex')."""
    if provider == "codex":
        return _find_in_paths(CODEX_PATHS, "codex")
    return _find_in_paths(CLAUDE_PATHS, "claude")


def detect_provider():
    """Auto-detect installed provider. Prefers Claude if both are present."""
    if find_binary("claude"):
        return "claude"
    if find_binary("codex"):
        return "codex"
    return None


def read_config_provider():
    """Read provider preference from config file. Returns resolved provider name or None."""
    try:
        with open(CONFIG_PATH) as f:
            data = json.load(f)
        pref = data.get("provider", "auto")
        if pref == "auto":
            return detect_provider()
        # Verify the chosen provider is actually installed
        if find_binary(pref):
            return pref
        # Preferred provider not installed — fall back to auto
        logging.warning("Preferred provider '%s' not found, falling back to auto-detect", pref)
        return detect_provider()
    except (OSError, json.JSONDecodeError):
        return detect_provider()


def write_config(provider):
    """Write provider preference to config file."""
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump({"provider": provider}, f)


def build_command(provider, binary, prompt, allowed_tools=None, max_turns=5, system_prompt=None):
    """Build the subprocess command list for the given provider."""
    if provider == "codex":
        cmd = [binary, "exec", prompt, "--json", "--full-auto"]
        if system_prompt:
            cmd += ["--append-system-prompt", system_prompt]
        return cmd

    # Claude Code
    cmd = [
        binary, "-p", prompt,
        "--output-format", "json",
    ]
    if allowed_tools:
        cmd += ["--allowedTools", allowed_tools]
    cmd += [
        "--permission-mode", "auto",
        "--max-turns", str(max_turns),
    ]
    if system_prompt:
        cmd += ["--append-system-prompt", system_prompt]
    return cmd


def parse_output(provider, stdout):
    """Parse CLI stdout into a usable text string.

    Claude: JSON envelope with result/content fields.
    Codex: JSONL stream — extract message content from events."""
    if provider == "codex":
        return _parse_codex_output(stdout)
    return _parse_claude_output(stdout)


def _parse_claude_output(stdout):
    """Parse Claude Code JSON output."""
    try:
        envelope = json.loads(stdout)
        return envelope.get("result") or envelope.get("content") or stdout
    except (json.JSONDecodeError, AttributeError):
        return stdout


def _parse_codex_output(stdout):
    """Parse Codex JSONL output. Extract text content from events."""
    texts = []
    for line in stdout.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Extract content from message events
        etype = event.get("type", "")

        # Handle output_text events directly
        if etype == "response.output_text.done":
            text = event.get("text", "")
            if text:
                texts.append(text)
            continue

        # Handle content parts in items
        if etype in ("response.output_item.done", "item.done"):
            item = event.get("item", event)
            for content in item.get("content", []):
                if content.get("type") == "output_text":
                    texts.append(content.get("text", ""))
                elif content.get("type") == "text":
                    texts.append(content.get("text", ""))
            continue

        # Handle completed responses
        if etype == "response.completed":
            resp = event.get("response", {})
            for output in resp.get("output", []):
                for content in output.get("content", []):
                    if content.get("type") in ("output_text", "text"):
                        texts.append(content.get("text", ""))

    return "\n".join(texts) if texts else stdout


def provider_display_name(provider):
    """Human-readable name for display in UI/logs."""
    return {"claude": "Claude Code", "codex": "Codex"}.get(provider, provider)


def provider_install_url(provider):
    """Install URL for the given provider."""
    if provider == "codex":
        return "https://github.com/openai/codex"
    return "https://claude.ai/code"
