#!/usr/bin/env bash
# Bootstrap a background worker worktree's Node/pnpm toolchain, then exec the
# built worker using that resolved environment.
set -euo pipefail

TASK_ID="${1:-}"
WORKER_SCRIPT="${2:-}"
ROLE="${3:-}"

if [[ -z "$TASK_ID" || -z "$WORKER_SCRIPT" ]]; then
  echo "usage: $0 <task-id> <worker-script> [role]" >&2
  exit 2
fi

if [[ ! -f "$WORKER_SCRIPT" ]]; then
  echo "worker script not found: $WORKER_SCRIPT" >&2
  exit 1
fi

SOURCE_ROOT="${JARVIS_SOURCE_ROOT:-}"
if [[ -z "$SOURCE_ROOT" ]]; then
  SOURCE_ROOT="$(cd "$(dirname "$WORKER_SCRIPT")/../.." && pwd)"
fi

DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
TASK_JSON="$DATA_BASE/data/background/tasks/$TASK_ID.json"
LOG_DIR="$DATA_BASE/data/background"
LOG_FILE="$LOG_DIR/bootstrap.log"
mkdir -p "$LOG_DIR"

# Keep bootstrap output somewhere inspectable. The worker is detached with
# ignored stdio, so otherwise nvm/pnpm failures vanish into the tasteful void.
exec >>"$LOG_FILE" 2>&1

echo "[$(date --iso-8601=seconds)] bootstrap start task=$TASK_ID role=${ROLE:-none} source=$SOURCE_ROOT"

if [[ ! -f "$TASK_JSON" ]]; then
  echo "task JSON not found: $TASK_JSON" >&2
  exit 1
fi

WORKTREE="$(python3 - "$TASK_JSON" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f)["worktree"])
PY
)"

if [[ -z "$WORKTREE" || ! -d "$WORKTREE" ]]; then
  echo "worktree not found for task $TASK_ID: $WORKTREE" >&2
  exit 1
fi

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_SH="$NVM_DIR/nvm.sh"
if [[ ! -s "$NVM_SH" ]]; then
  echo "nvm.sh not found: $NVM_SH" >&2
  exit 1
fi

export NVM_DIR
# shellcheck source=/dev/null
. "$NVM_SH"

cd "$WORKTREE"

if [[ -f .nvmrc ]]; then
  nvm install
  nvm use
else
  nvm install 22
  nvm use 22
fi

PACKAGE_MANAGER="$(node -p "require('./package.json').packageManager || ''")"
if [[ -z "$PACKAGE_MANAGER" ]]; then
  echo "package.json does not declare packageManager" >&2
  exit 1
fi

corepack enable
corepack prepare "$PACKAGE_MANAGER" --activate
pnpm install --frozen-lockfile

NODE_BIN="$(command -v node)"
PNPM_BIN="$(command -v pnpm)"
echo "resolved node=$NODE_BIN version=$($NODE_BIN --version)"
echo "resolved pnpm=$PNPM_BIN version=$(pnpm --version)"
echo "[$(date --iso-8601=seconds)] bootstrap complete task=$TASK_ID"

export JARVIS_BACKGROUND_BOOTSTRAPPED=1
export JARVIS_SOURCE_ROOT="$SOURCE_ROOT"
export JARVIS_WORKTREE="$WORKTREE"
export JARVIS_BACKGROUND_WORKTREE="$WORKTREE"
export JARVIS_BACKGROUND_NODE="$NODE_BIN"
export JARVIS_BACKGROUND_PNPM="$PNPM_BIN"

cd "$SOURCE_ROOT"

if [[ -n "$ROLE" ]]; then
  exec "$NODE_BIN" "$WORKER_SCRIPT" "$TASK_ID" "$ROLE"
fi
exec "$NODE_BIN" "$WORKER_SCRIPT" "$TASK_ID"
