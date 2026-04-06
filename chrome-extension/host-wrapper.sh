#!/bin/bash
# Wrapper to launch the Python native messaging host.
# Some Chromium-based browsers (e.g. Dia, Arc) cannot exec Python scripts
# directly via shebang — they require a shell script entry point.
#
# Chrome native messaging runs with a minimal PATH (no shell profile sourced).
# We need to restore the user's PATH so that CLI tools like claude/codex
# installed via npm, nvm, or Homebrew can be found.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/.web-to-figma-host.log"
echo "$(date): wrapper called" >> "$LOG"

# Restore user's PATH from their shell profile.
# Native messaging strips the environment, so tools installed via npm/nvm/homebrew
# won't be found without this.
if [ -f "$HOME/.zshrc" ]; then
  eval "$(ZDOTDIR="$HOME" zsh -ic 'echo export PATH=\"$PATH\"' 2>/dev/null)" 2>/dev/null
elif [ -f "$HOME/.bashrc" ]; then
  eval "$(bash -ic 'echo export PATH=\"$PATH\"' 2>/dev/null)" 2>/dev/null
elif [ -f "$HOME/.bash_profile" ]; then
  eval "$(bash -ic 'echo export PATH=\"$PATH\"' 2>/dev/null)" 2>/dev/null
fi

# Also add common tool locations directly as a fallback
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:/usr/local/bin:/opt/homebrew/bin:$PATH" 2>/dev/null

echo "$(date): PATH=$PATH" >> "$LOG"

# Find python3
for PYTHON in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  [ -x "$PYTHON" ] && break
done
[ -x "$PYTHON" ] || PYTHON=$(which python3 2>/dev/null) || PYTHON="python3"

exec "$PYTHON" "$SCRIPT_DIR/host.py"
