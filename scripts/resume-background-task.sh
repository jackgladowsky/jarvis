#!/usr/bin/env bash
set -euo pipefail

# Resume a failed single-worker background task in its existing worktree.
# Usage: scripts/resume-background-task.sh <task-id>

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO_ROOT/dist/background/resume.js" "$@"
