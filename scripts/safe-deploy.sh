#!/usr/bin/env bash
# Build and test a target revision in an isolated worktree before touching the
# live checkout. Activation preserves the old dist until the new source,
# dependencies, and prebuilt dist are all ready; failures roll back the clean
# checkout and dist rather than leaving the next reboot on a partial build.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
TARGET_REF="${1:-origin/main}"
RESTART_DELAY_SECONDS="${JARVIS_DEPLOY_RESTART_DELAY_SECONDS:-5}"
MARKER="$DATA_BASE/data/deploy/pending.json"
RESTART_LOG="$DATA_BASE/data/deploy/restart.log"
PREVIEW_PARENT=""
PREVIEW_WORKTREE=""
STAGED_DIST=""
DIST_BACKUP=""
OLD_REV=""
ACTIVATING=0

cd "$REPO_ROOT"
mkdir -p "$(dirname "$MARKER")"
if ! command -v flock >/dev/null 2>&1; then
  echo "flock is required for safe deploy serialization." >&2
  exit 1
fi
DEPLOY_LOCK="$DATA_BASE/data/deploy/deploy.lock"
exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
  echo "Another JARVIS deploy is already running." >&2
  exit 1
fi

# Telegram-launched shell commands do not necessarily inherit an interactive
# nvm PATH. Prefer an installed nvm Node when the current PATH has none.
if ! command -v node >/dev/null 2>&1 && compgen -G "$HOME/.nvm/versions/node/*/bin" >/dev/null; then
  for node_bin_dir in "$HOME"/.nvm/versions/node/*/bin; do
    [[ -d "$node_bin_dir" ]] && PATH="$node_bin_dir:$PATH"
  done
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node 20.18.1+ is required and node is not on PATH." >&2
  exit 1
fi
if ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>20 || (a===20 && (b>18 || (b===18 && c>=1))) ? 0 : 1)'; then
  echo "Node 20.18.1+ is required; found $(node --version)." >&2
  exit 1
fi
if [[ "$(node -p "require('./package.json').packageManager || ''")" != "pnpm@10.26.2" ]]; then
  echo "package.json must declare packageManager pnpm@10.26.2." >&2
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

# Prove the unattended delayed restart has a loaded unit and non-interactive
# sudo authorization before changing source or dist.
JARVIS_UNIT_STATE="$(sudo -n systemctl show jarvis.service --property=LoadState --value 2>/dev/null || true)"
if [[ "$JARVIS_UNIT_STATE" != "loaded" ]]; then
  echo "Cannot inspect jarvis.service with non-interactive sudo; refusing activation." >&2
  exit 1
fi
if ! sudo -n -l systemctl restart jarvis >/dev/null; then
  echo "Non-interactive sudo is not authorized to restart jarvis; refusing activation." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo "Refusing to deploy: working tree has uncommitted or untracked changes." >&2
  echo "Stash or commit them first, then re-run." >&2
  exit 1
fi

OLD_REV="$(git rev-parse HEAD)"
OLD_SHORT="$(git rev-parse --short HEAD)"

if [[ "$TARGET_REF" == origin/* ]]; then
  echo "Fetching..."
  git fetch origin
fi

NEW_REV="$(git rev-parse --verify "$TARGET_REF^{commit}")"
NEW_SHORT="$(git rev-parse --short "$NEW_REV")"
if ! git merge-base --is-ancestor "$OLD_REV" "$NEW_REV"; then
  echo "Refusing to deploy non-fast-forward target $TARGET_REF ($NEW_SHORT)." >&2
  exit 1
fi

cleanup() {
  local exit_code=$?
  set +e
  if [[ "$ACTIVATING" -eq 1 && "$exit_code" -ne 0 ]]; then
    echo "Activation failed; restoring source and dist to $OLD_SHORT." >&2
    if [[ -n "$DIST_BACKUP" && -d "$DIST_BACKUP" ]]; then
      rm -rf "$REPO_ROOT/dist"
      mv "$DIST_BACKUP" "$REPO_ROOT/dist"
    fi
    git -C "$REPO_ROOT" reset --hard "$OLD_REV" >/dev/null
    (cd "$REPO_ROOT" && pnpm install --frozen-lockfile --offline) >/dev/null 2>&1 || true
  fi
  if [[ -n "$PREVIEW_WORKTREE" && -e "$PREVIEW_WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$PREVIEW_WORKTREE" >/dev/null 2>&1 || true
  fi
  [[ -n "$PREVIEW_PARENT" ]] && rm -rf "$PREVIEW_PARENT"
  [[ -n "$STAGED_DIST" ]] && rm -rf "$STAGED_DIST"
  if [[ "$ACTIVATING" -eq 0 || "$exit_code" -eq 0 ]]; then
    [[ -n "$DIST_BACKUP" ]] && rm -rf "$DIST_BACKUP"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

PREVIEW_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-deploy.XXXXXX")"
PREVIEW_WORKTREE="$PREVIEW_PARENT/release"
echo "Preparing isolated release worktree for $NEW_SHORT..."
git worktree add --detach "$PREVIEW_WORKTREE" "$NEW_REV"

cd "$PREVIEW_WORKTREE"
export JARVIS_SOURCE_ROOT="$PREVIEW_WORKTREE"
echo "Installing release dependencies (frozen lockfile)..."
pnpm install --frozen-lockfile
echo "Typechecking release..."
pnpm run typecheck
echo "Building release with no partial emit..."
pnpm run build -- --noEmitOnError
echo "Testing release..."
TEST_DATA="$PREVIEW_PARENT/test-data"
mkdir -p "$TEST_DATA/prompts"
cp "$PREVIEW_WORKTREE/config.yaml.example" "$TEST_DATA/config.yaml"
cp "$PREVIEW_WORKTREE/prompts/system.md.example" "$TEST_DATA/prompts/system.md"
export JARVIS_DATA_DIR="$TEST_DATA"
export TELEGRAM_BOT_TOKEN="safe-deploy-test-token"
export TELEGRAM_ALLOWED_USER_IDS="123"
export EXA_API_KEY="safe-deploy-test-key"
pnpm test

# Keep the staged dist on the same filesystem as the live dist so each rename
# in the activation window is atomic.
STAGED_DIST="$REPO_ROOT/.jarvis-dist-next-$$"
DIST_BACKUP="$REPO_ROOT/.jarvis-dist-previous-$$"
rm -rf "$STAGED_DIST" "$DIST_BACKUP"
cp -a "$PREVIEW_WORKTREE/dist" "$STAGED_DIST"

cd "$REPO_ROOT"
export JARVIS_SOURCE_ROOT="$REPO_ROOT"
export JARVIS_DATA_DIR="$DATA_BASE"
if ! git diff --quiet HEAD --; then
  echo "Tracked files changed while the release was being verified; refusing activation." >&2
  exit 1
fi
echo "Activating source $OLD_SHORT → $NEW_SHORT..."
git merge --ff-only "$NEW_REV"
ACTIVATING=1

# The isolated install warmed pnpm's content store. Offline activation avoids
# a network failure after the live checkout has moved.
pnpm install --frozen-lockfile --offline

if [[ -d "$REPO_ROOT/dist" ]]; then
  mv "$REPO_ROOT/dist" "$DIST_BACKUP"
fi
mv "$STAGED_DIST" "$REPO_ROOT/dist"
STAGED_DIST=""
ACTIVATING=0
rm -rf "$DIST_BACKUP"
DIST_BACKUP=""

STARTED_AT="$(date --iso-8601=seconds)"
python3 - "$MARKER" "$STARTED_AT" "$OLD_REV" "$NEW_REV" "$TARGET_REF" <<'PY'
import json
import os
import sys
import tempfile

path, started_at, old_rev, new_rev, target_ref = sys.argv[1:]
directory = os.path.dirname(path)
os.makedirs(directory, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".pending-", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({
            "started_at": started_at,
            "old_rev": old_rev,
            "new_rev": new_rev,
            "target_ref": target_ref,
        }, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY

notify_deploy_built() {
  local text="$1"
  if [[ ! -f "$DATA_BASE/.env" || ! -f "$DATA_BASE/config.yaml" ]]; then
    return 0
  fi

  python3 - "$DATA_BASE" "$DATA_BASE/.env" "$DATA_BASE/config.yaml" "$text" <<'PY'
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
import urllib.parse
import urllib.request

base, env_path, config_path, text = sys.argv[1:5]
env = {}
with open(env_path, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key] = value.strip().strip('"').strip("'")

token = env.get("TELEGRAM_BOT_TOKEN")
chat_id = None
with open(config_path, encoding="utf-8") as f:
    for line in f:
        match = re.match(r"\s*telegram_chat_id:\s*(-?\d+)\s*$", line)
        if match:
            chat_id = int(match.group(1))
            break

if not chat_id:
    sys.exit(0)

notifications = os.path.join(base, "data", "notifications")
os.makedirs(notifications, exist_ok=True)
notification = {
    "id": f"{int(time.time() * 1000)}-{os.getpid()}-deploy-built",
    "source": "deploy",
    "chat_id": chat_id,
    "title": "JARVIS deploy built",
    "body": text,
    "prompt": text,
    "fallback_text": text,
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "status": "pending",
    "attempts": 0,
    "max_attempts": 8,
}
notification_path = os.path.join(notifications, notification["id"] + ".json")
fd, temporary = tempfile.mkstemp(prefix=".deploy-notification-", suffix=".tmp", dir=notifications)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(notification, f, indent=2)
    f.write("\n")
    f.flush()
    os.fsync(f.fileno())
os.replace(temporary, notification_path)

heartbeat_path = os.path.join(notifications, "heartbeat.json")
alive = False
try:
    with open(heartbeat_path, encoding="utf-8") as f:
        heartbeat = json.load(f)
    updated_at = heartbeat.get("updated_at", "")
    updated = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    alive = (datetime.now(timezone.utc) - updated).total_seconds() <= 30
except Exception:
    alive = False

if alive or not token:
    sys.exit(0)

data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
request = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()
    notification["status"] = "processed"
    notification["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    archive = os.path.join(notifications, "archive")
    os.makedirs(archive, exist_ok=True)
    with open(notification_path, "w", encoding="utf-8") as f:
        json.dump(notification, f, indent=2)
        f.write("\n")
    os.replace(notification_path, os.path.join(archive, "processed-" + os.path.basename(notification_path)))
except Exception:
    # Leave the durable pending notification for the restarted pump.
    pass
PY
}

notify_deploy_built "JARVIS deploy built: $OLD_SHORT → $NEW_SHORT. Restarting in ${RESTART_DELAY_SECONDS}s; back-online notice follows."

# Detach the restart so this script can return to the running agent before
# systemd stops it. sudo must be non-interactive; otherwise the log records it.
(
  exec 9>&-
  sleep "$RESTART_DELAY_SECONDS"
  sudo -n systemctl restart jarvis
) >> "$RESTART_LOG" 2>&1 &
disown || true

echo "Built, tested, and activated $OLD_SHORT → $NEW_SHORT. Restart scheduled in ${RESTART_DELAY_SECONDS}s."
echo "Pending marker: $MARKER"
