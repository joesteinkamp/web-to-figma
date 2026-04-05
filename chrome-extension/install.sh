#!/bin/bash
# Convenience wrapper — calls the unified setup script from the repo root.
exec "$(cd "$(dirname "$0")/.." && pwd)/setup.sh" "$@"
