#!/usr/bin/env bash
# Install /etc/systemd/system/jarvis.service and /etc/logrotate.d/jarvis.
#
# Probes the running user, repo path, and node binary at install time so the
# unit doesn't bake in any /home/<x> assumptions. Re-running is safe — it
# overwrites the unit file with a fresh render of current paths.
#
# Does NOT auto-start the service. After this finishes, sanity-check the
# config (~/.jarvis/.env, ~/.jarvis/config.yaml, ~/.jarvis/.codex-creds.json)
# and then `sudo systemctl start jarvis`.
set -euo pipefail

DRY_RUN=0
ENABLE_SERVICE=1

usage() {
  cat <<EOF
Usage: scripts/install-systemd.sh [options]

Options:
  --dry-run     Print the rendered unit/logrotate config and commands without writing /etc.
  --no-enable   Install files and reload systemd, but do not enable jarvis.service at boot.
  -h, --help    Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --no-enable) ENABLE_SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
USER_NAME="$(whoami)"
GROUP_NAME="$(id -gn)"

# Resolve absolute path to node — `User=` in systemd doesn't carry the
# user's PATH, so we can't rely on `node` resolving via lookup at runtime.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find 'node' on PATH." >&2
  echo "Install Node 22.5+ first, then re-run." >&2
  exit 1
fi
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=5) ? 0 : 1)'; then
  echo "Node 22.5+ is required; found $($NODE_BIN --version)." >&2
  exit 1
fi

# Pre-flight: make sure the build artifact exists. Nothing worse than a
# unit that ExecStart= can't find at boot.
if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
  echo "Build artifact missing: $REPO_ROOT/dist/index.js" >&2
  echo "Run \`pnpm install && pnpm run build\` first (or scripts/setup-host.sh)." >&2
  exit 1
fi

# Pre-flight: make sure the env file exists. `EnvironmentFile=` with a
# missing target is a startup failure with a noisy systemd error.
if [[ ! -f "$DATA_BASE/.env" ]]; then
  echo "Missing env file: $DATA_BASE/.env" >&2
  echo "Run scripts/setup-host.sh first to bootstrap ~/.jarvis/." >&2
  exit 1
fi

UNIT="/etc/systemd/system/jarvis.service"
LOGROTATE="/etc/logrotate.d/jarvis"

UNIT_CONTENT="$(cat <<EOF
[Unit]
Description=JARVIS personal assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$DATA_BASE/.env
Environment="JARVIS_DATA_DIR=$DATA_BASE"
Environment="JARVIS_SOURCE_ROOT=$REPO_ROOT"
ExecStart=$NODE_BIN $REPO_ROOT/dist/index.js
# Always restart if the process exits unexpectedly, including a clean return
# from Telegram polling. An explicit systemctl stop still suppresses restart.
# RestartSec gives Telegram's long-poll a moment to settle before we reconnect.
Restart=always
RestartSec=5
# Keep self-deploy restarts snappy; Telegram long-poll shutdown should not
# make a deploy feel haunted.
TimeoutStopSec=10
# Detached worker processes are stopped with the controller. Startup recovery
# relaunches only safely queued/unclaimed work; interrupted active stages are
# quarantined for owner review instead of replayed.
KillMode=control-group
# Logs flow into journald — \`journalctl -fu jarvis\` to follow.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
)"

LOGROTATE_CONTENT="$(cat <<EOF
$DATA_BASE/data/audit.log $DATA_BASE/data/lifecycle-audit.jsonl {
    daily
    rotate 30
    compress
    missingok
    notifempty
    create 0600 $USER_NAME $GROUP_NAME
    su $USER_NAME $GROUP_NAME
}
EOF
)"

write_root_file() {
  local path="$1"
  local content="$2"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] would write $path:"
    printf '%s\n' "$content"
  else
    sudo tee "$path" > /dev/null <<< "$content"
  fi
}

run_root() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

echo "Installing systemd unit at $UNIT"
echo "  User:                $USER_NAME"
echo "  WorkingDirectory:    $REPO_ROOT"
echo "  EnvironmentFile:     $DATA_BASE/.env"
echo "  JARVIS_DATA_DIR:     $DATA_BASE"
echo "  JARVIS_SOURCE_ROOT:  $REPO_ROOT"
echo "  ExecStart:           $NODE_BIN $REPO_ROOT/dist/index.js"
write_root_file "$UNIT" "$UNIT_CONTENT"

echo "Installing logrotate config at $LOGROTATE"
# JARVIS opens the audit path for each durable append, so normal rename/create
# rotation is safe and avoids copytruncate's data-loss window.
write_root_file "$LOGROTATE" "$LOGROTATE_CONTENT"

echo "Reloading systemd..."
run_root sudo systemctl daemon-reload

if [[ "$ENABLE_SERVICE" -eq 1 ]]; then
  echo "Enabling jarvis.service (start at boot)..."
  run_root sudo systemctl enable jarvis.service
else
  echo "Skipping enable (--no-enable)."
fi

cat <<EOF

Installed. Useful commands:

  sudo systemctl start jarvis      # start now
  sudo systemctl status jarvis     # check status
  scripts/safe-deploy.sh           # deploy code changes safely
  sudo systemctl restart jarvis    # deliberate manual config/service restart
  journalctl -fu jarvis            # follow logs

If you'd been running JARVIS as a foreground process, kill it before
starting the service so two copies don't fight over Telegram polling.
EOF
