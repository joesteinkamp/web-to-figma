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
    os.path.expanduser("~/.npm-global/bin/codex"),
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
        cmd = [binary, "--dangerously-bypass-approvals-and-sandbox", "exec", "--skip-git-repo-check", "--json", prompt]
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
    """Parse Codex JSONL output. Extract text content from events.

    Codex exec --json emits JSONL with these relevant event types:
      - item.completed with item.type "agent_message" → final text answer
      - item.completed with item.type "mcp_tool_call" → MCP tool result
      - turn.completed → usage stats (ignored)
    """
    texts = []
    for line in stdout.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type", "")

        if etype == "item.completed":
            item = event.get("item", {})
            item_type = item.get("type", "")

            # Agent's text response
            if item_type == "agent_message":
                text = item.get("text", "")
                if text:
                    texts.append(text)

            # MCP tool call result — extract text from result content
            elif item_type == "mcp_tool_call":
                result = item.get("result")
                if result:
                    # result.content is an array of content blocks
                    for block in result.get("content", []):
                        if block.get("type") == "text":
                            texts.append(block.get("text", ""))
                    # Also check structured_content
                    sc = result.get("structured_content")
                    if sc and isinstance(sc, dict):
                        texts.append(json.dumps(sc))

    return "\n".join(texts) if texts else stdout


def provider_display_name(provider):
    """Human-readable name for display in UI/logs."""
    return {"claude": "Claude Code", "codex": "Codex"}.get(provider, provider)


def provider_install_url(provider):
    """Install URL for the given provider."""
    if provider == "codex":
        return "https://github.com/openai/codex"
    return "https://claude.ai/code"
