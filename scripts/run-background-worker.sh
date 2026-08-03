#!/usr/bin/env bash
# Launch an already-deployed JARVIS worker artifact. Task state/PID handshakes
# and durable startup failures stay in this control-plane launcher; project
# setup belongs to the agent after it starts in its controller-prepared worktree.
set -euo pipefail

TASK_ID="${1:-}"
WORKER_RUNTIME="${2:-}"
WORKER_ARTIFACT="${3:-}"
if [[ -z "$TASK_ID" || -z "$WORKER_RUNTIME" || -z "$WORKER_ARTIFACT" || -n "${4:-}" ]]; then
  echo "usage: $0 <task-id> <worker-runtime> <worker-artifact>" >&2
  exit 2
fi

DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
TASK_JSON="$DATA_BASE/data/background/tasks/$TASK_ID.json"
LOG_DIR="$DATA_BASE/data/background"
LOG_FILE="$LOG_DIR/bootstrap.log"
BOOTSTRAP_FAILURE_DIR="$LOG_DIR/bootstrap-failures"
BOOTSTRAP_FAILURE="$BOOTSTRAP_FAILURE_DIR/$TASK_ID.json"
mkdir -p "$LOG_DIR"

# Detached workers have ignored stdio; retain launcher diagnostics.
exec >>"$LOG_FILE" 2>&1

echo "[$(date --iso-8601=seconds)] launcher start task=$TASK_ID artifact=$WORKER_ARTIFACT"

mark_launcher_failed() {
  local exit_code="$1"
  local line="$2"
  trap - ERR
  mkdir -p "$BOOTSTRAP_FAILURE_DIR"
  python3 - "$BOOTSTRAP_FAILURE" "$TASK_ID" "$exit_code" "$line" <<'PY' || true
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, task_id, exit_code, line = sys.argv[1:]
try:
    message = f"background worker launcher failed at line {line} (exit {exit_code})"
    failure = {
        "task_id": task_id,
        "error": message,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    directory = os.path.dirname(path)
    fd, temporary = tempfile.mkstemp(prefix=".launcher-failed-", suffix=".tmp", dir=directory)
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
    print(f"could not persist launcher failure: {error}", file=sys.stderr)
PY
  echo "[$(date --iso-8601=seconds)] launcher failed task=$TASK_ID exit=$exit_code line=$line" >&2
  exit "$exit_code"
}

trap 'mark_launcher_failed $? $LINENO' ERR
rm -f "$BOOTSTRAP_FAILURE"

if [[ ! -f "$TASK_JSON" ]]; then
  echo "task JSON not found: $TASK_JSON" >&2
  mark_launcher_failed 1 "$LINENO"
fi
if [[ ! -x "$WORKER_RUNTIME" ]]; then
  echo "worker runtime is not executable: $WORKER_RUNTIME" >&2
  mark_launcher_failed 1 "$LINENO"
fi
if [[ ! -f "$WORKER_ARTIFACT" ]]; then
  echo "worker artifact not found: $WORKER_ARTIFACT" >&2
  mark_launcher_failed 1 "$LINENO"
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

echo "[$(date --iso-8601=seconds)] launcher complete task=$TASK_ID"
rm -f "$BOOTSTRAP_FAILURE"

# The controller supplies an already-deployed runtime and artifact and starts
# us with cwd set to the validated task worktree. Do not bootstrap either
# JARVIS or the target project here.
export JARVIS_BACKGROUND_BOOTSTRAPPED=1
exec "$WORKER_RUNTIME" "$WORKER_ARTIFACT" "$TASK_ID"
