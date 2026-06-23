#!/usr/bin/env bash
# Set up the JARVIS data tree on a fresh host.
# Idempotent: re-running never overwrites live files. Safe to run after pulls.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"

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

# .env holds secrets after you edit it; tighten perms unconditionally.
chmod 600 "$DATA_BASE/.env"

echo "Installing deps..."
( cd "$REPO_ROOT" && pnpm install )

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
