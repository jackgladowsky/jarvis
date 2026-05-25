#!/usr/bin/env bash
set -euo pipefail

# Resume an existing background task in-place, appending a fixer/reviewer pass.
# Usage: scripts/resume-background-task.sh <task-id> [fixer|reviewer]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO_ROOT/dist/background/resume.js" "$@"
