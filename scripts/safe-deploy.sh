#!/usr/bin/env bash
# Safely update/build JARVIS and restart it without killing the chat response
# mid-tool-call.
#
# Flow:
#   1. Refuse dirty working trees.
#   2. Fast-forward to the requested ref (default: origin/main).
#   3. Install deps and build. If this fails, do not restart.
#   4. Write a pending deploy marker and queue an internal notification
#      (Telegram fallback if the main notification pump is unavailable).
#   5. Schedule a short delayed systemd restart in the background, then exit.
#      On startup, JARVIS consumes the marker and sends a back-online notice.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
TARGET_REF="${1:-origin/main}"
RESTART_DELAY_SECONDS="${JARVIS_DEPLOY_RESTART_DELAY_SECONDS:-5}"
MARKER="$DATA_BASE/data/deploy/pending.json"
RESTART_LOG="$DATA_BASE/data/deploy/restart.log"

cd "$REPO_ROOT"
mkdir -p "$(dirname "$MARKER")"

# Telegram-launched shell commands do not necessarily inherit Jack's interactive
# nvm PATH. Prefer any installed nvm Node so `pnpm`'s /usr/bin/env node shim
# works from both terminals and JARVIS tool calls.
if ! command -v node >/dev/null 2>&1 && compgen -G "$HOME/.nvm/versions/node/*/bin" >/dev/null; then
  for node_bin_dir in "$HOME"/.nvm/versions/node/*/bin; do
    PATH="$node_bin_dir:$PATH"
  done
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Could not find pnpm on PATH." >&2
  exit 1
fi

if ! git diff --quiet HEAD --; then
  echo "Refusing to deploy: working tree has uncommitted changes." >&2
  echo "Stash or commit them first, then re-run." >&2
  exit 1
fi

OLD_REV="$(git rev-parse HEAD)"
OLD_SHORT="$(git rev-parse --short HEAD)"

if [[ "$TARGET_REF" == origin/* ]]; then
  echo "Fetching..."
  git fetch origin
fi

echo "Fast-forwarding to $TARGET_REF..."
git merge --ff-only "$TARGET_REF"

NEW_REV="$(git rev-parse HEAD)"
NEW_SHORT="$(git rev-parse --short HEAD)"
if [[ "$OLD_REV" == "$NEW_REV" ]]; then
  echo "Already up to date ($OLD_SHORT)."
  exit 0
fi

echo "Installing deps..."
pnpm install

echo "Building..."
pnpm run build

STARTED_AT="$(date --iso-8601=seconds)"
cat > "$MARKER" <<EOF_MARKER
{
  "started_at": "$STARTED_AT",
  "old_rev": "$OLD_REV",
  "new_rev": "$NEW_REV",
  "target_ref": "$TARGET_REF"
}
EOF_MARKER

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
}
notification_path = os.path.join(notifications, notification["id"] + ".json")
with open(notification_path, "w", encoding="utf-8") as f:
    json.dump(notification, f, indent=2)
    f.write("\n")

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
    # Notification failure should not block a deploy that already built.
    pass
PY
}

notify_deploy_built "JARVIS deploy built: $OLD_SHORT → $NEW_SHORT. Restarting in ${RESTART_DELAY_SECONDS}s; back-online notice follows."

# Detach the restart so this script can return to the running agent before
# systemd stops it. sudo must be non-interactive; otherwise the log will show it.
(
  sleep "$RESTART_DELAY_SECONDS"
  sudo -n systemctl restart jarvis
) >> "$RESTART_LOG" 2>&1 &
disown || true

echo "Built $OLD_SHORT → $NEW_SHORT. Restart scheduled in ${RESTART_DELAY_SECONDS}s."
echo "Pending marker: $MARKER"
