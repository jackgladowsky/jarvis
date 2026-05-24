#!/usr/bin/env bash
# Start a long-running background JARVIS worker from the built runtime.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1 && compgen -G "$HOME/.nvm/versions/node/*/bin" >/dev/null; then
  for node_bin_dir in "$HOME"/.nvm/versions/node/*/bin; do
    PATH="$node_bin_dir:$PATH"
  done
fi

exec node "$REPO_ROOT/dist/background/start.js" "$@"
