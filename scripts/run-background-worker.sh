#!/usr/bin/env bash
# Bootstrap a task worktree once, then run every worker stage from that
# worktree. Bootstrap failures are written back to the durable task record so
# they cannot sit in "queued" forever with only a detached log as evidence.
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
BOOTSTRAP_FAILURE_DIR="$LOG_DIR/bootstrap-failures"
BOOTSTRAP_FAILURE="$BOOTSTRAP_FAILURE_DIR/$TASK_ID.json"
mkdir -p "$LOG_DIR"

# Detached workers have ignored stdio; retain bootstrap diagnostics.
exec >>"$LOG_FILE" 2>&1

echo "[$(date --iso-8601=seconds)] bootstrap start task=$TASK_ID role=${ROLE:-none} source=$SOURCE_ROOT"

mark_bootstrap_failed() {
  local exit_code="$1"
  local line="$2"
  trap - ERR
  mkdir -p "$BOOTSTRAP_FAILURE_DIR"
  python3 - "$BOOTSTRAP_FAILURE" "$TASK_ID" "$ROLE" "$exit_code" "$line" <<'PY' || true
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, task_id, role, exit_code, line = sys.argv[1:]
try:
    message = f"background worker bootstrap failed at line {line} (exit {exit_code})"
    failure = {
        "task_id": task_id,
        "role": role,
        "error": message,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".bootstrap-failed-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(failure, f, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
except Exception as error:
    print(f"could not persist bootstrap failure: {error}", file=sys.stderr)
PY
  echo "[$(date --iso-8601=seconds)] bootstrap failed task=$TASK_ID role=${ROLE:-none} exit=$exit_code line=$line" >&2
  exit "$exit_code"
}

trap 'mark_bootstrap_failed $? $LINENO' ERR
rm -f "$BOOTSTRAP_FAILURE"

if [[ ! -f "$TASK_JSON" ]]; then
  echo "task JSON not found: $TASK_JSON" >&2
  exit 1
fi

# The manager spawns this launcher and then persists our PID under its task
# lock. Do not let worker.ts read/write the prior revision before that commit.
PID_HANDSHAKE_OK=0
for _ in {1..200}; do
  RECORDED_PID="$(python3 - "$TASK_JSON" <<'PY' 2>/dev/null || true
import json
import sys
with open(sys.argv[1], encoding="utf-8") as f:
    print(json.load(f).get("pid", ""))
PY
)"
  if [[ "$RECORDED_PID" == "$$" ]]; then
    PID_HANDSHAKE_OK=1
    break
  fi
  sleep 0.05
done
if [[ "$PID_HANDSHAKE_OK" -ne 1 ]]; then
  echo "timed out waiting for controller to persist launcher pid $$" >&2
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

cd "$WORKTREE"

NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_SH="$NVM_DIR/nvm.sh"
if [[ -s "$NVM_SH" ]]; then
  export NVM_DIR
  # shellcheck source=/dev/null
  . "$NVM_SH"
  if [[ -f .nvmrc ]]; then
    nvm use --silent >/dev/null 2>&1 || nvm install
  else
    nvm use --silent 22 >/dev/null 2>&1 || nvm install 22
  fi
elif ! command -v node >/dev/null 2>&1; then
  echo "Node is not available on PATH and nvm is not installed." >&2
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=13) ? 0 : 1)'; then
  echo "Node 22.13+ is required; found $(node --version)." >&2
  exit 1
fi

PACKAGE_MANAGER="$(node -p "require('./package.json').packageManager || ''")"
if [[ "$PACKAGE_MANAGER" != "pnpm@10.26.2" ]]; then
  echo "package.json must declare packageManager pnpm@10.26.2; found ${PACKAGE_MANAGER:-none}" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != "10.26.2" ]]; then
  if ! command -v corepack >/dev/null 2>&1; then
    echo "pnpm 10.26.2 is required and corepack is unavailable." >&2
    exit 1
  fi
  corepack enable
  corepack prepare pnpm@10.26.2 --activate
fi
if [[ "$(pnpm --version)" != "10.26.2" ]]; then
  echo "Could not activate pnpm 10.26.2; found $(pnpm --version)." >&2
  exit 1
fi

FINGERPRINT="$(sha256sum package.json pnpm-lock.yaml | sha256sum | cut -d' ' -f1)"
BOOTSTRAP_MARKER="$WORKTREE/node_modules/.jarvis-background-bootstrap"
PREVIOUS_FINGERPRINT=""
if [[ -f "$BOOTSTRAP_MARKER" ]]; then
  PREVIOUS_FINGERPRINT="$(head -n 1 "$BOOTSTRAP_MARKER")"
fi

if [[ "$PREVIOUS_FINGERPRINT" != "$FINGERPRINT" || ! -d node_modules ]]; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable
    corepack prepare pnpm@10.26.2 --activate
  elif ! command -v pnpm >/dev/null 2>&1; then
    echo "Neither corepack nor pnpm is available." >&2
    exit 1
  fi
  pnpm install --frozen-lockfile
  mkdir -p node_modules
  printf '%s\n' "$FINGERPRINT" > "$BOOTSTRAP_MARKER"
  echo "[$(date --iso-8601=seconds)] dependency bootstrap complete task=$TASK_ID"
else
  echo "[$(date --iso-8601=seconds)] dependency bootstrap reused task=$TASK_ID"
fi

NODE_BIN="$(command -v node)"
PNPM_BIN="$(command -v pnpm)"
echo "resolved node=$NODE_BIN version=$($NODE_BIN --version)"
echo "resolved pnpm=$PNPM_BIN version=$($PNPM_BIN --version)"
echo "[$(date --iso-8601=seconds)] bootstrap complete task=$TASK_ID worktree=$WORKTREE"
rm -f "$BOOTSTRAP_FAILURE"

export JARVIS_BACKGROUND_BOOTSTRAPPED=1
export JARVIS_CONTROLLER_SOURCE_ROOT="$SOURCE_ROOT"
export JARVIS_SOURCE_ROOT="$WORKTREE"
export JARVIS_WORKTREE="$WORKTREE"
export JARVIS_BACKGROUND_WORKTREE="$WORKTREE"
export JARVIS_BACKGROUND_NODE="$NODE_BIN"
export JARVIS_BACKGROUND_PNPM="$PNPM_BIN"

# Tool CWD is a security/correctness boundary. Keep it in the assigned
# worktree; the worker script itself remains the already-built main artifact.
cd "$WORKTREE"

if [[ -n "$ROLE" ]]; then
  exec "$NODE_BIN" "$WORKER_SCRIPT" "$TASK_ID" "$ROLE"
fi
exec "$NODE_BIN" "$WORKER_SCRIPT" "$TASK_ID"
