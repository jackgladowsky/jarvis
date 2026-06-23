#!/usr/bin/env bash
# Interactive first-run installer for JARVIS.
# Curl usage:
#   curl -fsSL https://raw.githubusercontent.com/<owner>/jarvis/main/scripts/install.sh | bash
set -euo pipefail

REPO_URL="${JARVIS_REPO_URL:-https://github.com/<owner>/jarvis.git}"
REPO_DIR="${JARVIS_REPO_DIR:-$HOME/jarvis}"
DATA_DIR="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
BRANCH="${JARVIS_BRANCH:-main}"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
info() { color 36 "$*"; }
warn() { color 33 "$*"; }
fatal() { color 31 "ERROR: $*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

prompt() {
  local label="$1" default="${2:-}" value
  if [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " value || true
    printf '%s' "${value:-$default}"
  else
    read -r -p "$label: " value || true
    printf '%s' "$value"
  fi
}

prompt_secret() {
  local label="$1" value
  read -r -s -p "$label: " value || true
  printf '\n' >&2
  printf '%s' "$value"
}

replace_env_value() {
  local key="$1" value="$2" file="$3"
  python3 - "$key" "$value" "$file" <<'PY'
import sys
from pathlib import Path
key, value, file = sys.argv[1:4]
path = Path(file)
lines = path.read_text(encoding="utf-8").splitlines()
out = []
written = False
for line in lines:
    if line.startswith(f"{key}="):
        out.append(f"{key}={value}")
        written = True
    else:
        out.append(line)
if not written:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n", encoding="utf-8")
PY
}

replace_yaml_scalar() {
  local dotted_key="$1" value="$2" file="$3"
  node --input-type=module - "$dotted_key" "$value" "$file" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [key, value, file] = process.argv.slice(2);
const lines = readFileSync(file, "utf-8").split(/\r?\n/);
const [section, leaf] = key.split(".");
let inSection = false;
let replaced = false;
const out = lines.map((line) => {
  if (line.match(new RegExp(`^${section}:\\s*$`))) {
    inSection = true;
    return line;
  }
  if (inSection && line.match(/^\S/)) inSection = false;
  if (inSection && line.match(new RegExp(`^\\s+${leaf}:`))) {
    replaced = true;
    return `  ${leaf}: ${value}`;
  }
  return line;
});
if (!replaced) throw new Error(`Could not find ${key} in ${file}`);
writeFileSync(file, out.join("\n"), "utf-8");
NODE
}

cat <<'EOF'

JARVIS installer
================
This will clone/update the repo, create ~/.jarvis if needed, collect basic
Telegram/model config, build the project, and optionally install systemd.
Existing host-local files are preserved unless you choose to update values.

EOF

if [[ "$REPO_URL" == "https://github.com/<owner>/jarvis.git" ]]; then
  warn "JARVIS_REPO_URL is still the placeholder. Set it for curl installs from your fork."
  REPO_URL="$(prompt "Git repo URL" "$REPO_URL")"
fi

have git || fatal "git is required"
have node || fatal "Node.js 20+ is required"
have pnpm || fatal "pnpm 10+ is required (try: corepack enable)"
have python3 || fatal "python3 is required"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(`.`)[0])')"
[[ "$NODE_MAJOR" -ge 20 ]] || fatal "Node.js 20+ is required; found $(node --version)"

if [[ -d "$REPO_DIR/.git" ]]; then
  info "Using existing repo: $REPO_DIR"
  git -C "$REPO_DIR" fetch --all --prune
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" pull --ff-only
elif [[ -e "$REPO_DIR" ]]; then
  fatal "$REPO_DIR exists but is not a git repo"
else
  info "Cloning $REPO_URL -> $REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

info "Bootstrapping host-local data in $DATA_DIR"
JARVIS_DATA_DIR="$DATA_DIR" "$REPO_DIR/scripts/setup-host.sh"

ENV_FILE="$DATA_DIR/.env"
CONFIG_FILE="$DATA_DIR/config.yaml"

update_env="$(prompt "Update .env values now? (y/n)" "y")"
if [[ "$update_env" =~ ^[Yy]$ ]]; then
  token="$(prompt_secret "Telegram bot token")"
  allowed="$(prompt "Allowed Telegram user IDs (comma-separated)")"
  exa="$(prompt_secret "Exa API key")"
  [[ -n "$token" ]] && replace_env_value TELEGRAM_BOT_TOKEN "$token" "$ENV_FILE"
  [[ -n "$allowed" ]] && replace_env_value TELEGRAM_ALLOWED_USER_IDS "$allowed" "$ENV_FILE"
  [[ -n "$exa" ]] && replace_env_value EXA_API_KEY "$exa" "$ENV_FILE"

  provider="$(prompt "Model provider (codex/anthropic)" "codex")"
  replace_yaml_scalar agent.provider "$provider" "$CONFIG_FILE"
  model_default="gpt-5.1"
  [[ "$provider" == "anthropic" ]] && model_default="claude-sonnet-4-6"
  model="$(prompt "Model" "$model_default")"
  replace_yaml_scalar agent.model "$model" "$CONFIG_FILE"

  if [[ "$provider" == "anthropic" ]]; then
    anthropic="$(prompt_secret "Anthropic API key")"
    [[ -n "$anthropic" ]] && replace_env_value ANTHROPIC_API_KEY "$anthropic" "$ENV_FILE"
  fi

  timezone="$(prompt "Scheduler timezone" "$(timedatectl show -p Timezone --value 2>/dev/null || printf UTC)")"
  replace_yaml_scalar scheduler.timezone "$timezone" "$CONFIG_FILE"
  chmod 600 "$ENV_FILE"
fi

cat <<EOF

Host-local files:
  Secrets: $ENV_FILE
  Config:  $CONFIG_FILE
  Host:    $DATA_DIR/AGENTS.md
  Prompt:  $DATA_DIR/prompts/system.md
EOF

install_service="$(prompt "Install systemd service? (y/n)" "n")"
if [[ "$install_service" =~ ^[Yy]$ ]]; then
  "$REPO_DIR/scripts/install-systemd.sh"
  warn "Service installed but not started. Start with: sudo systemctl start jarvis"
fi

cat <<EOF

Done.

Next:
  cd $REPO_DIR
  node --env-file=$ENV_FILE dist/index.js

Or, if systemd was installed:
  sudo systemctl start jarvis
  journalctl -fu jarvis
EOF
