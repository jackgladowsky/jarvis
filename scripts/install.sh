#!/usr/bin/env bash
# One-command installer and first-run onboarding for JARVIS.
#
# Curl usage:
#   curl -fsSL https://raw.githubusercontent.com/jackgladowsky/jarvis/main/scripts/install.sh | bash
#
# Safe/idempotent by default: existing config/secrets are not overwritten unless
# you confirm an edit in the wizard. Use --dry-run to preview actions.
set -euo pipefail
umask 077

DEFAULT_REPO_URL="https://github.com/jackgladowsky/jarvis.git"
REPO_URL="${JARVIS_REPO_URL:-$DEFAULT_REPO_URL}"
BRANCH="${JARVIS_BRANCH:-main}"
INSTALL_DIR="${JARVIS_INSTALL_DIR:-$HOME/jarvis}"
DATA_DIR="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
SKIP_SYSTEMD=0
DRY_RUN=0
YES=0

usage() {
  cat <<EOF
JARVIS installer/onboarding wizard

Usage: scripts/install.sh [options]
       curl -fsSL <raw-url>/scripts/install.sh | bash -s -- [options]

Options:
  --repo-url URL       Git repo to clone (default: $DEFAULT_REPO_URL)
  --branch NAME        Branch/ref to checkout when cloning (default: main)
  --install-dir DIR    Source checkout path (default: ~/jarvis)
  --data-dir DIR       Host-local data/config path (default: ~/.jarvis)
  --skip-systemd       Do not install/enable the systemd service
  --dry-run            Print planned actions without changing files
  -y, --yes            Accept safe defaults for prompts (non-secret values stay blank)
  -h, --help           Show this help

Environment overrides: JARVIS_REPO_URL, JARVIS_BRANCH, JARVIS_INSTALL_DIR, JARVIS_DATA_DIR.
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

expand_path() {
  local path="$1"
  case "$path" in
    ~) printf '%s\n' "$HOME" ;;
    ~/*) printf '%s/%s\n' "$HOME" "${path#~/}" ;;
    /*) printf '%s\n' "$path" ;;
    *) printf '%s/%s\n' "$(pwd)" "$path" ;;
  esac
}

INSTALL_DIR="$(expand_path "$INSTALL_DIR")"
DATA_DIR="$(expand_path "$DATA_DIR")"

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

run_shell() {
  local cmd="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run] %s\n' "$cmd"
  else
    bash -c "$cmd"
  fi
}

can_prompt() { [[ -e /dev/tty ]] && { : <> /dev/tty; } 2>/dev/null; }

require_prompt_or_yes() {
  if [[ "$YES" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    return
  fi
  can_prompt && return
  fail "interactive onboarding needs a terminal. Re-run from an interactive shell, or pass --yes to accept defaults/non-interactive behavior."
}

prompt_yes_no() {
  local prompt="$1"
  local default="$2"
  local reply suffix
  if [[ "$YES" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    [[ "$default" == "yes" ]]
    return
  fi
  require_prompt_or_yes
  if [[ "$default" == "yes" ]]; then suffix='[Y/n]'; else suffix='[y/N]'; fi
  while true; do
    read -r -p "$prompt $suffix " reply < /dev/tty
    reply="${reply:-$default}"
    case "${reply,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) log "Please answer yes or no." ;;
    esac
  done
}

prompt_value() {
  local prompt="$1"
  local current="$2"
  local secret="${3:-0}"
  local reply display
  if [[ "$YES" -eq 1 || "$DRY_RUN" -eq 1 ]]; then
    printf '%s\n' "$current"
    return
  fi
  require_prompt_or_yes
  display="$current"
  if [[ "$secret" -eq 1 && -n "$current" ]]; then display='********'; fi
  if [[ "$secret" -eq 1 ]]; then
    read -r -s -p "$prompt [$display]: " reply < /dev/tty
    printf '\n' > /dev/tty
  else
    read -r -p "$prompt [$display]: " reply < /dev/tty
  fi
  printf '%s\n' "${reply:-$current}"
}

require_cmd() {
  local cmd="$1"
  local hint="$2"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required command '$cmd'. $hint"
}

current_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { exit found ? 0 : 0 }' "$file" | tail -n 1
}

write_env_file() {
  local env_file="$1"
  local token="$2"
  local allowed="$3"
  local exa="$4"
  local anthropic="$5"
  local openrouter="$6"

  log "Writing secrets file: $env_file"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] would update selected keys in $env_file with chmod 600 (values redacted)"
    return
  fi

  # Update only the fields owned by onboarding. Preserve OPENROUTER_API_KEY,
  # CODEX_OAUTH_CREDS_PATH, and any host-specific variables/comments so an
  # installer rerun cannot silently erase a working configuration.
  python3 - "$env_file" "$token" "$allowed" "$anthropic" "$openrouter" "$exa" <<'PY'
from pathlib import Path
import os
import re
import sys
import tempfile

path = Path(sys.argv[1])
updates = {
    "TELEGRAM_BOT_TOKEN": sys.argv[2],
    "TELEGRAM_ALLOWED_USER_IDS": sys.argv[3],
    "ANTHROPIC_API_KEY": sys.argv[4],
    "OPENROUTER_API_KEY": sys.argv[5],
    "EXA_API_KEY": sys.argv[6],
}

if path.exists():
    lines = path.read_text(encoding="utf-8").splitlines()
else:
    lines = [
        "# JARVIS secrets. Loaded by systemd via EnvironmentFile=.",
        "# Edited by scripts/install.sh onboarding wizard.",
        "",
    ]

seen = set()
out = []
for line in lines:
    match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
    if match and match.group(1) in updates:
        key = match.group(1)
        if key not in seen:
            out.append(f"{key}={updates[key]}")
            seen.add(key)
        continue
    out.append(line)

if out and out[-1] != "":
    out.append("")
for key, value in updates.items():
    if key not in seen:
        out.append(f"{key}={value}")

path.parent.mkdir(parents=True, exist_ok=True)
fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(out).rstrip("\n") + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp_name, 0o600)
    os.replace(tmp_name, path)
finally:
    try:
        os.unlink(tmp_name)
    except FileNotFoundError:
        pass
PY
}

patch_config() {
  local config_file="$1"
  local provider="$2"
  local model="$3"
  local timezone="$4"
  [[ -f "$config_file" ]] || return 0
  log "Updating onboarding choices in: $config_file"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] would set agent.provider=$provider, agent.model=$model, scheduler.timezone=$timezone"
    return
  fi
  python3 - "$config_file" "$provider" "$model" "$timezone" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
provider, model, timezone = sys.argv[2:5]
text = path.read_text()

def replace_first(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf'(?m)^(\s*{re.escape(key)}:\s*)([^#\n]*)(\s*(#.*)?)$')
    def repl(match: re.Match[str]) -> str:
        comment = match.group(4)
        suffix = f'  {comment}' if comment else ''
        return f'{match.group(1)}{value}{suffix}'
    return pattern.sub(repl, text, count=1)

text = replace_first(text, 'provider', provider)
text = replace_first(text, 'model', model)
text = replace_first(text, 'timezone', timezone)
path.write_text(text)
PY
}

clone_or_update_repo() {
  require_cmd git "Install git and re-run."
  if [[ -e "$INSTALL_DIR/.git" ]]; then
    log "Using existing checkout: $INSTALL_DIR"
    return
  fi
  if [[ -e "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR exists but is not a git checkout. Pick --install-dir or move it aside."
  fi
  log "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
  run git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
}

bootstrap_repo() {
  require_cmd node "Install Node.js 20.18.1+ first: https://nodejs.org/"
  if ! node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>20 || (a===20 && (b>18 || (b===18 && c>=1))) ? 0 : 1)'; then
    fail "Node.js 20.18.1+ is required; found $(node --version)."
  fi
  if ! command -v pnpm >/dev/null 2>&1 || [[ "$(pnpm --version)" != "10.26.2" ]]; then
    require_cmd corepack "Install pnpm 10.26.2 first: corepack enable && corepack prepare pnpm@10.26.2 --activate"
    log "activating repository-pinned pnpm 10.26.2 through corepack"
    run corepack enable
    run corepack prepare pnpm@10.26.2 --activate
  fi
  if [[ "$DRY_RUN" -eq 0 && "$(pnpm --version)" != "10.26.2" ]]; then
    fail "pnpm 10.26.2 is required; found $(pnpm --version)."
  fi
  require_cmd python3 "Install python3 and re-run."

  log "Bootstrapping host-local data tree and building JARVIS"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "[dry-run] would run: JARVIS_DATA_DIR=$DATA_DIR $INSTALL_DIR/scripts/setup-host.sh"
  else
    JARVIS_DATA_DIR="$DATA_DIR" "$INSTALL_DIR/scripts/setup-host.sh"
  fi
}

onboard() {
  local env_file="$DATA_DIR/.env"
  local config_file="$DATA_DIR/config.yaml"
  local token allowed exa anthropic openrouter provider model timezone

  log ""
  log "Onboarding JARVIS"
  log "  Source: $INSTALL_DIR"
  log "  Data:   $DATA_DIR"

  token="$(current_env_value "$env_file" TELEGRAM_BOT_TOKEN)"
  allowed="$(current_env_value "$env_file" TELEGRAM_ALLOWED_USER_IDS)"
  exa="$(current_env_value "$env_file" EXA_API_KEY)"
  anthropic="$(current_env_value "$env_file" ANTHROPIC_API_KEY)"
  openrouter="$(current_env_value "$env_file" OPENROUTER_API_KEY)"

  if prompt_yes_no "Configure Telegram/Exa/API secrets now?" "yes"; then
    token="$(prompt_value 'Telegram bot token from @BotFather' "$token" 1)"
    allowed="$(prompt_value 'Allowed Telegram user IDs (comma-separated numeric IDs)' "$allowed" 0)"
    exa="$(prompt_value 'Exa API key for web_search' "$exa" 1)"
    anthropic="$(prompt_value 'Anthropic API key (optional; leave blank if using Codex)' "$anthropic" 1)"
    openrouter="$(prompt_value 'OpenRouter API key (optional)' "$openrouter" 1)"
    write_env_file "$env_file" "$token" "$allowed" "$exa" "$anthropic" "$openrouter"
  else
    log "Leaving $env_file unchanged."
  fi

  provider="codex"
  model="gpt-5.1"
  timezone="$(cat /etc/timezone 2>/dev/null || printf 'America/New_York')"
  if prompt_yes_no "Configure basic model/timezone settings now?" "yes"; then
    provider="$(prompt_value 'Agent provider (codex, anthropic, or openrouter)' "$provider" 0)"
    model="$(prompt_value 'Model name' "$model" 0)"
    timezone="$(prompt_value 'Scheduler timezone' "$timezone" 0)"
    patch_config "$config_file" "$provider" "$model" "$timezone"
  fi
}

install_systemd() {
  if [[ "$SKIP_SYSTEMD" -eq 1 ]]; then
    log "Skipping systemd install (--skip-systemd)."
    return
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipping systemd install."
    return
  fi
  if prompt_yes_no "Install and enable jarvis.service with systemd?" "yes"; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      log "[dry-run] would run: JARVIS_DATA_DIR=$DATA_DIR $INSTALL_DIR/scripts/install-systemd.sh"
    else
      JARVIS_DATA_DIR="$DATA_DIR" "$INSTALL_DIR/scripts/install-systemd.sh"
    fi
  else
    log "Not installing systemd service."
  fi
}

main() {
  log "JARVIS installer"
  log "----------------"
  require_prompt_or_yes
  clone_or_update_repo
  bootstrap_repo
  onboard
  install_systemd

  cat <<EOF

Done. JARVIS is installed/onboarded.

Next steps:
  - Review secrets/config: $DATA_DIR/.env and $DATA_DIR/config.yaml
  - Foreground run:       cd $INSTALL_DIR && JARVIS_SOURCE_ROOT=$INSTALL_DIR JARVIS_DATA_DIR=$DATA_DIR node --env-file=$DATA_DIR/.env dist/index.js
  - If systemd installed: sudo systemctl start jarvis && journalctl -fu jarvis

EOF
}

main "$@"
