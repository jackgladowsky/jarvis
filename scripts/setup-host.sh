#!/usr/bin/env bash
# Set up the JARVIS data tree on a fresh host.
# Idempotent: re-running never overwrites live files. Safe to run after pulls.
set -euo pipefail
umask 077

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=5) ? 0 : 1)'; then
  echo "Node 22.5+ is required." >&2
  exit 1
fi
if [[ "$(node -p "require(process.argv[1]).packageManager || ''" "$REPO_ROOT/package.json")" != "pnpm@10.26.2" ]]; then
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

echo "Setting up JARVIS data tree at: $DATA_BASE"

mkdir -p "$DATA_BASE/prompts"
mkdir -p "$DATA_BASE/data/sessions/archive"
mkdir -p "$DATA_BASE/data/notes/projects/archive"
mkdir -p "$DATA_BASE/cache"

copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [[ -e "$dst" ]]; then
    echo "  exists, skipping: $dst"
  else
    cp "$src" "$dst"
    echo "  copied:           $dst"
  fi
}

copy_if_missing "$REPO_ROOT/.env.example"               "$DATA_BASE/.env"
copy_if_missing "$REPO_ROOT/config.yaml.example"        "$DATA_BASE/config.yaml"
copy_if_missing "$REPO_ROOT/AGENTS.md.example"          "$DATA_BASE/AGENTS.md"
copy_if_missing "$REPO_ROOT/prompts/system.md.example"  "$DATA_BASE/prompts/system.md"

# Everything below the host-local root may contain prompts, transcripts,
# credentials, logs, or generated artifacts. Do not rely on the caller's
# umask, and never follow symlinks while tightening an existing installation.
find "$DATA_BASE" -type d -exec chmod 700 {} +
find "$DATA_BASE" -type f -exec chmod 600 {} +

echo "Installing deps..."
( cd "$REPO_ROOT" && pnpm install --frozen-lockfile )

echo "Building..."
( cd "$REPO_ROOT" && pnpm run build )

cat <<EOF

Done.

Next steps:
  1. Edit $DATA_BASE/.env (TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ...).
  2. Edit $DATA_BASE/config.yaml if defaults need tuning.
  3. Edit $DATA_BASE/AGENTS.md with this host's specifics.
  4. Run: pnpm start    (or install systemd service: scripts/install-systemd.sh)
EOF
