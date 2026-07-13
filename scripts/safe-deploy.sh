#!/usr/bin/env bash
# Verify a revision in an isolated worktree, cache its exact dist artifact, then
# atomically activate it and schedule the existing delayed restart workflow.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
MODE="remote"
if [[ "${1:-}" == "--self-main" ]]; then
  MODE="self-main"
  shift
  if [[ "$#" -ne 0 ]]; then
    echo "--self-main does not accept a target ref." >&2
    exit 2
  fi
fi
TARGET_REF="${1:-origin/main}"
RESTART_DELAY_SECONDS="${JARVIS_DEPLOY_RESTART_DELAY_SECONDS:-5}"
DEPLOY_DIR="$DATA_BASE/data/deploy"
MARKER="$DEPLOY_DIR/pending.json"
ACTIVE_FILE="$DEPLOY_DIR/active.json"
RESTART_LOG="$DEPLOY_DIR/restart.log"
CACHE_CONTRACT_VERSION="2"
PREVIEW_PARENT=""
PREVIEW_WORKTREE=""
PUSH_PARENT=""
PUSH_WORKTREE=""
STAGED_DIST=""
DIST_BACKUP=""
NODE_MODULES_BACKUP=""
STATE_BACKUP_DIR=""
OLD_REV=""
OLD_SHORT=""
DEPLOY_OLD_REV=""
NEW_REV=""
NEW_SHORT=""
ACTIVATING=0
DIST_ACTIVATING=0
DEPENDENCIES_ACTIVATING=0
LIFECYCLE_CHANGED=0

fail() { echo "$*" >&2; exit 1; }

cd "$REPO_ROOT"
mkdir -p "$DEPLOY_DIR"
if [[ -n "${JARVIS_BACKGROUND_BOOTSTRAPPED:-}" || -n "${JARVIS_BACKGROUND_WORKTREE:-}" ]]; then
  fail "Deploy is forbidden from a background worker. Main JARVIS is the deploy gate."
fi
command -v flock >/dev/null 2>&1 || fail "flock is required for safe deploy serialization."
exec 9>"$DEPLOY_DIR/deploy.lock"
flock -n 9 || fail "Another JARVIS deploy is already running."

# Telegram-launched commands may not inherit an interactive nvm PATH.
if ! command -v node >/dev/null 2>&1 && compgen -G "$HOME/.nvm/versions/node/*/bin" >/dev/null; then
  for node_bin_dir in "$HOME"/.nvm/versions/node/*/bin; do
    [[ -d "$node_bin_dir" ]] && PATH="$node_bin_dir:$PATH"
  done
fi
command -v node >/dev/null 2>&1 || fail "Node 20.18.1+ is required and node is not on PATH."
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>20 || (a===20 && (b>18 || (b===18 && c>=1))) ? 0 : 1)' \
  || fail "Node 20.18.1+ is required; found $(node --version)."
[[ "$(node -p "require('./package.json').packageManager || ''")" == "pnpm@10.26.2" ]] \
  || fail "package.json must declare packageManager pnpm@10.26.2."
if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != "10.26.2" ]]; then
  command -v corepack >/dev/null 2>&1 || fail "pnpm 10.26.2 is required and corepack is unavailable."
  corepack enable
  corepack prepare pnpm@10.26.2 --activate
fi
PNPM_VERSION="$(pnpm --version)"
[[ "$PNPM_VERSION" == "10.26.2" ]] || fail "Could not activate pnpm 10.26.2; found $PNPM_VERSION."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"

# Prove restart prerequisites before any push or activation.
JARVIS_UNIT_STATE="$(sudo -n systemctl show jarvis.service --property=LoadState --value 2>/dev/null || true)"
[[ "$JARVIS_UNIT_STATE" == "loaded" ]] \
  || fail "Cannot inspect jarvis.service with non-interactive sudo; refusing activation."
sudo -n -l systemctl restart jarvis >/dev/null \
  || fail "Non-interactive sudo is not authorized to restart jarvis; refusing activation."

require_clean_tree() {
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] \
    || fail "Refusing to deploy: working tree has uncommitted or untracked changes."
}
require_self_main_state() {
  [[ "$(git rev-parse --show-toplevel)" == "$REPO_ROOT" ]] || fail "Self-main must run from the attached main checkout."
  [[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)" == "main" ]] \
    || fail "Self-main requires the attached local main branch."
  [[ "$(git rev-parse HEAD)" == "$NEW_REV" ]] || fail "Local main HEAD changed during self deploy; refusing."
  require_clean_tree
}
require_clean_tree
OLD_REV="$(git rev-parse HEAD)"
DEPLOY_OLD_REV="$OLD_REV"

if [[ -f "$ACTIVE_FILE" ]]; then
  ACTIVE_REV="$(python3 - "$ACTIVE_FILE" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        print(json.load(f).get("sha", ""))
except (OSError, ValueError):
    pass
PY
)"
  if [[ -n "$ACTIVE_REV" ]] && git cat-file -e "$ACTIVE_REV^{commit}" 2>/dev/null; then
    DEPLOY_OLD_REV="$ACTIVE_REV"
  fi
fi
OLD_SHORT="$(git rev-parse --short "$DEPLOY_OLD_REV")"

if [[ "$MODE" == "self-main" ]]; then
  NEW_REV="$OLD_REV" # immutable release identity captured before fetch/build
  require_self_main_state
  echo "Fetching origin/main..."
  git fetch origin main
  REMOTE_REV="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"
  git merge-base --is-ancestor "$REMOTE_REV" "$NEW_REV" \
    || fail "Refusing self deploy: origin/main is not an ancestor of local main."
else
  if [[ "$TARGET_REF" == origin/* ]]; then
    echo "Fetching..."
    git fetch origin
  fi
  NEW_REV="$(git rev-parse --verify "$TARGET_REF^{commit}")"
  git merge-base --is-ancestor "$OLD_REV" "$NEW_REV" \
    || fail "Refusing to deploy non-fast-forward target $TARGET_REF."
fi
NEW_SHORT="$(git rev-parse --short "$NEW_REV")"
PACKAGE_FINGERPRINT="$(git archive "$NEW_REV" package.json pnpm-lock.yaml | git hash-object --stdin)"
CACHE_ROOT="$DATA_BASE/cache/deploy"
CACHE_DIR="$CACHE_ROOT/$NEW_REV"
mkdir -p "$CACHE_ROOT"

dist_digest() {
  node - "$1" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(process.argv[2]);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join('/'));
    else throw new Error(`unsupported dist entry: ${full}`);
  }
}
walk(root);
files.sort();
const hash = crypto.createHash('sha256');
for (const file of files) {
  hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, file))); hash.update('\0');
}
process.stdout.write(hash.digest('hex'));
NODE
}

dependencies_digest() {
  node - "$1" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(process.argv[2]);
const entries = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) entries.push([relative, 'file', fs.readFileSync(full)]);
    else if (entry.isSymbolicLink()) {
      // pnpm's layout uses relative links. Reject links that escape the cache,
      // so a valid manifest cannot make preflight depend on arbitrary host files.
      const target = fs.realpathSync(full);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`dependency symlink escapes cache: ${full}`);
      }
      entries.push([relative, 'symlink', fs.readlinkSync(full)]);
    } else throw new Error(`unsupported dependency entry: ${full}`);
  }
}
walk(root);
entries.sort(([a], [b]) => a.localeCompare(b));
const hash = crypto.createHash('sha256');
for (const [relative, type, content] of entries) {
  hash.update(type); hash.update('\0'); hash.update(relative); hash.update('\0'); hash.update(content); hash.update('\0');
}
process.stdout.write(hash.digest('hex'));
NODE
}

cache_is_valid() {
  [[ -d "$CACHE_DIR/dist" && -f "$CACHE_DIR/dist/index.js" && -d "$CACHE_DIR/node_modules" && -f "$CACHE_DIR/manifest.json" ]] || return 1
  local digest dependencies
  digest="$(dist_digest "$CACHE_DIR/dist")" || return 1
  dependencies="$(dependencies_digest "$CACHE_DIR/node_modules")" || return 1
  python3 - "$CACHE_DIR/manifest.json" "$CACHE_CONTRACT_VERSION" "$NEW_REV" "$NODE_MAJOR" "$PNPM_VERSION" "$PACKAGE_FINGERPRINT" "$digest" "$dependencies" <<'PY'
import json, sys
path, contract, sha, node_major, pnpm, fingerprint, digest, dependencies = sys.argv[1:]
try:
    with open(path, encoding="utf-8") as f:
        value = json.load(f)
except (OSError, ValueError):
    raise SystemExit(1)
expected = {
    "contract_version": int(contract), "sha": sha, "node_major": int(node_major),
    "pnpm_version": pnpm, "package_lock_fingerprint": fingerprint, "dist_digest": digest,
    "dependencies_digest": dependencies,
}
raise SystemExit(0 if value == expected else 1)
PY
}

cleanup() {
  local exit_code=$?
  set +e
  if [[ "$ACTIVATING" -eq 1 && "$exit_code" -ne 0 ]]; then
    echo "Activation failed; restoring the previous release." >&2
    if [[ "$DIST_ACTIVATING" -eq 1 ]]; then
      rm -rf "$REPO_ROOT/dist"
      if [[ -n "$DIST_BACKUP" && -d "$DIST_BACKUP" ]]; then mv "$DIST_BACKUP" "$REPO_ROOT/dist"; fi
    fi
    if [[ "$LIFECYCLE_CHANGED" -eq 1 ]]; then
      rm -f "$MARKER" "$ACTIVE_FILE"
      [[ -f "$STATE_BACKUP_DIR/pending.json" ]] && mv "$STATE_BACKUP_DIR/pending.json" "$MARKER"
      [[ -f "$STATE_BACKUP_DIR/active.json" ]] && mv "$STATE_BACKUP_DIR/active.json" "$ACTIVE_FILE"
    fi
    # Source commits are never reset during rollback: source is inert until a
    # built dist is activated, and a reset could race another main-session edit.
    # Restore only the runtime artifacts that the running service consumes.
    if [[ "$DEPENDENCIES_ACTIVATING" -eq 1 ]]; then
      rm -rf "$REPO_ROOT/node_modules"
      if [[ -n "$NODE_MODULES_BACKUP" && -d "$NODE_MODULES_BACKUP" ]]; then
        mv "$NODE_MODULES_BACKUP" "$REPO_ROOT/node_modules"
        NODE_MODULES_BACKUP=""
      fi
    fi
  fi
  if [[ -n "$PREVIEW_WORKTREE" && -e "$PREVIEW_WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$PREVIEW_WORKTREE" >/dev/null 2>&1 || true
  fi
  if [[ -n "$PUSH_WORKTREE" && -e "$PUSH_WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$PUSH_WORKTREE" >/dev/null 2>&1 || true
  fi
  [[ -n "$PREVIEW_PARENT" ]] && rm -rf "$PREVIEW_PARENT"
  [[ -n "$PUSH_PARENT" ]] && rm -rf "$PUSH_PARENT"
  [[ -n "$STATE_BACKUP_DIR" ]] && rm -rf "$STATE_BACKUP_DIR"
  [[ -n "$NODE_MODULES_BACKUP" ]] && rm -rf "$NODE_MODULES_BACKUP"
  [[ -n "$STAGED_DIST" ]] && rm -rf "$STAGED_DIST"
  if [[ "$ACTIVATING" -eq 0 || "$exit_code" -eq 0 ]]; then [[ -n "$DIST_BACKUP" ]] && rm -rf "$DIST_BACKUP"; fi
  exit "$exit_code"
}
trap cleanup EXIT

if cache_is_valid; then
  echo "Using verified deploy cache for $NEW_SHORT."
else
  [[ ! -e "$CACHE_DIR" ]] || rm -rf "$CACHE_DIR"
  PREVIEW_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-deploy.XXXXXX")"
  PREVIEW_WORKTREE="$PREVIEW_PARENT/release"
  echo "Preparing isolated release worktree for $NEW_SHORT..."
  git worktree add --detach "$PREVIEW_WORKTREE" "$NEW_REV"
  cd "$PREVIEW_WORKTREE"
  export JARVIS_SOURCE_ROOT="$PREVIEW_WORKTREE"
  echo "Installing release dependencies (frozen lockfile)..."
  pnpm install --frozen-lockfile
  echo "Compiling release once with no partial emit..."
  pnpm run build
  echo "Running compiled tests directly..."
  TEST_DATA="$PREVIEW_PARENT/test-data"
  mkdir -p "$TEST_DATA/prompts"
  cp config.yaml.example "$TEST_DATA/config.yaml"
  cp prompts/system.md.example "$TEST_DATA/prompts/system.md"
  export JARVIS_DATA_DIR="$TEST_DATA" TELEGRAM_BOT_TOKEN="safe-deploy-test-token" TELEGRAM_ALLOWED_USER_IDS="123" EXA_API_KEY="safe-deploy-test-key"
  mapfile -d '' TEST_FILES < <(find dist -name '*.test.js' -print0)
  [[ "${#TEST_FILES[@]}" -gt 0 ]] || fail "Compiled release contains no tests."
  node --test "${TEST_FILES[@]}"
  # The cache is also used before live node_modules is activated, so retain the
  # release's production dependency layout next to dist. Prune only after tests
  # because TypeScript and the test runner are development dependencies.
  echo "Pruning release dependencies to production only..."
  pnpm prune --prod
  DIGEST="$(dist_digest "$PREVIEW_WORKTREE/dist")"
  DEPENDENCIES_DIGEST="$(dependencies_digest "$PREVIEW_WORKTREE/node_modules")"
  CACHE_TEMP="$CACHE_ROOT/.${NEW_REV}.tmp.$$"
  rm -rf "$CACHE_TEMP"
  mkdir -p "$CACHE_TEMP"
  cp -a "$PREVIEW_WORKTREE/dist" "$CACHE_TEMP/dist"
  cp -a "$PREVIEW_WORKTREE/node_modules" "$CACHE_TEMP/node_modules"
  python3 - "$CACHE_TEMP/manifest.json" "$CACHE_CONTRACT_VERSION" "$NEW_REV" "$NODE_MAJOR" "$PNPM_VERSION" "$PACKAGE_FINGERPRINT" "$DIGEST" "$DEPENDENCIES_DIGEST" <<'PY'
import json, os, sys
path, contract, sha, node_major, pnpm, fingerprint, digest, dependencies = sys.argv[1:]
with open(path, "w", encoding="utf-8") as f:
    json.dump({"contract_version": int(contract), "sha": sha, "node_major": int(node_major),
               "pnpm_version": pnpm, "package_lock_fingerprint": fingerprint,
               "dist_digest": digest, "dependencies_digest": dependencies}, f, indent=2, sort_keys=True)
    f.write("\n"); f.flush(); os.fsync(f.fileno())
directory_fd = os.open(os.path.dirname(path), os.O_RDONLY)
try:
    os.fsync(directory_fd)
finally:
    os.close(directory_fd)
PY
  mv "$CACHE_TEMP" "$CACHE_DIR"
  cache_is_valid || fail "Newly published deploy cache failed validation."
fi

# Validate the actual host configuration with the exact artifact about to be
# activated. This happens before any source/dist swap, so an incompatible live
# config cannot take the currently-running release offline.
[[ -f "$DATA_BASE/config.yaml" ]] || fail "Live config is missing: $DATA_BASE/config.yaml"
echo "Preflighting live config with release $NEW_SHORT..."
node "$CACHE_DIR/dist/config-check.js" "$DATA_BASE/config.yaml"

cd "$REPO_ROOT"
export JARVIS_SOURCE_ROOT="$REPO_ROOT" JARVIS_DATA_DIR="$DATA_BASE"
if [[ "$MODE" == "self-main" ]]; then
  require_self_main_state
else
  require_clean_tree
  [[ "$(git rev-parse HEAD)" == "$OLD_REV" ]] || fail "Local HEAD changed during verification; refusing activation."
fi

ensure_live_dependencies() {
  local marker="$REPO_ROOT/node_modules/.jarvis-deploy-fingerprint"
  if [[ -d "$REPO_ROOT/node_modules" && -f "$marker" && "$(head -n 1 "$marker")" == "$PACKAGE_FINGERPRINT" ]]; then
    echo "Live dependencies already match $NEW_SHORT."
    return
  fi
  NODE_MODULES_BACKUP="$REPO_ROOT/.jarvis-node-modules-previous-$$"
  rm -rf "$NODE_MODULES_BACKUP"
  if [[ -d "$REPO_ROOT/node_modules" ]]; then mv "$REPO_ROOT/node_modules" "$NODE_MODULES_BACKUP"; fi
  DEPENDENCIES_ACTIVATING=1
  echo "Activating verified production dependencies from the release cache..."
  cp -a "$CACHE_DIR/node_modules" "$REPO_ROOT/node_modules"
  printf '%s\n' "$PACKAGE_FINGERPRINT" > "$marker"
}

push_verified_self_main() {
  # The live checkout intentionally has production-only dependencies after an
  # activation. Run the repository's pre-push hook from a fresh isolated
  # worktree with the exact commit's development dependencies instead of
  # bypassing it with --no-verify or temporarily mutating the live checkout.
  PUSH_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/jarvis-deploy-push.XXXXXX")"
  PUSH_WORKTREE="$PUSH_PARENT/release"
  echo "Preparing isolated pre-push worktree for $NEW_SHORT..."
  git worktree add --detach "$PUSH_WORKTREE" "$NEW_REV"
  (
    cd "$PUSH_WORKTREE"
    export JARVIS_SOURCE_ROOT="$PUSH_WORKTREE"
    echo "Installing pre-push validation dependencies (frozen lockfile)..."
    pnpm install --frozen-lockfile
    echo "Publishing exact verified SHA $NEW_SHORT to origin/main..."
    # Never use --no-verify: this executes the repository hook with the exact
    # revision and its development dependencies. The non-force push preserves
    # the server-side race check against origin/main.
    git push origin "$NEW_REV:refs/heads/main"
  )
  git -C "$REPO_ROOT" worktree remove --force "$PUSH_WORKTREE"
  rm -rf "$PUSH_PARENT"
  PUSH_WORKTREE=""
  PUSH_PARENT=""
}

if [[ "$MODE" == "self-main" ]]; then
  require_clean_tree
  require_self_main_state
  push_verified_self_main
  CONFIRMED_REMOTE="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
  [[ "$CONFIRMED_REMOTE" == "$NEW_REV" ]] || fail "Remote main did not resolve to the verified SHA after push."
  # Only activate production dependencies after the validated push succeeds.
  # This keeps a failed pre-push check from mutating live runtime artifacts.
  ACTIVATING=1
  ensure_live_dependencies
  require_self_main_state
else
  echo "Activating source $OLD_SHORT → $NEW_SHORT..."
  ACTIVATING=1
  git merge --ff-only "$NEW_REV"
  ensure_live_dependencies
fi

# Stage on the live filesystem so both activation renames are atomic.
STAGED_DIST="$REPO_ROOT/.jarvis-dist-next-$$"
DIST_BACKUP="$REPO_ROOT/.jarvis-dist-previous-$$"
rm -rf "$STAGED_DIST" "$DIST_BACKUP"
cp -a "$CACHE_DIR/dist" "$STAGED_DIST"
ACTIVATING=1
DIST_ACTIVATING=1
if [[ -d "$REPO_ROOT/dist" ]]; then mv "$REPO_ROOT/dist" "$DIST_BACKUP"; fi
mv "$STAGED_DIST" "$REPO_ROOT/dist"
STAGED_DIST=""

STATE_BACKUP_DIR="$(mktemp -d "$DEPLOY_DIR/.state-backup.XXXXXX")"
[[ -f "$MARKER" ]] && cp -a "$MARKER" "$STATE_BACKUP_DIR/pending.json"
[[ -f "$ACTIVE_FILE" ]] && cp -a "$ACTIVE_FILE" "$STATE_BACKUP_DIR/active.json"
LIFECYCLE_CHANGED=1
STARTED_AT="$(date --iso-8601=seconds)"
python3 - "$MARKER" "$STARTED_AT" "$DEPLOY_OLD_REV" "$NEW_REV" "$TARGET_REF" <<'PY'
import json, os, sys, tempfile
path, started_at, old_rev, new_rev, target_ref = sys.argv[1:]
directory = os.path.dirname(path); os.makedirs(directory, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".pending-", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"started_at": started_at, "old_rev": old_rev, "new_rev": new_rev,
                   "target_ref": target_ref}, f, indent=2)
        f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
python3 - "$ACTIVE_FILE" "$NEW_REV" "$DEPLOY_OLD_REV" "$STARTED_AT" <<'PY'
import json, os, sys, tempfile
path, sha, prior, activated_at = sys.argv[1:]
directory = os.path.dirname(path); os.makedirs(directory, exist_ok=True)
fd, temporary = tempfile.mkstemp(prefix=".active-", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"sha": sha, "prior_sha": prior or None, "activated_at": activated_at}, f, indent=2)
        f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
ACTIVATING=0
rm -rf "$DIST_BACKUP" "$NODE_MODULES_BACKUP"
DIST_BACKUP=""
NODE_MODULES_BACKUP=""
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
