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

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_BASE="${JARVIS_DATA_DIR:-$HOME/.jarvis}"
USER_NAME="$(whoami)"

# Resolve absolute path to node — `User=` in systemd doesn't carry the
# user's PATH, so we can't rely on `node` resolving via lookup at runtime.
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find 'node' on PATH." >&2
  echo "Install Node 20+ first, then re-run." >&2
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

echo "Installing systemd unit at $UNIT"
echo "  User:                $USER_NAME"
echo "  WorkingDirectory:    $REPO_ROOT"
echo "  EnvironmentFile:     $DATA_BASE/.env"
echo "  ExecStart:           $NODE_BIN $REPO_ROOT/dist/index.js"

sudo tee "$UNIT" > /dev/null <<EOF
[Unit]
Description=JARVIS personal assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$DATA_BASE/.env
ExecStart=$NODE_BIN $REPO_ROOT/dist/index.js
# Auto-restart if the process exits non-zero (uncaught exception, OOM, …).
# RestartSec gives Telegram's long-poll a moment to settle before we reconnect.
Restart=on-failure
RestartSec=5
# Keep self-deploy restarts snappy; Telegram long-poll shutdown should not
# make a deploy feel haunted.
TimeoutStopSec=10
# Logs flow into journald — \`journalctl -fu jarvis\` to follow.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

echo "Installing logrotate config at $LOGROTATE"
# copytruncate matters: Node's appendFile holds an open fd, so a plain
# rotation (rename + create) would leave JARVIS writing to the rotated
# file. copytruncate copies then truncates the original in place.
sudo tee "$LOGROTATE" > /dev/null <<EOF
$DATA_BASE/data/audit.log {
    daily
    rotate 30
    compress
    missingok
    notifempty
    copytruncate
}
EOF

echo "Reloading systemd..."
sudo systemctl daemon-reload

echo "Enabling jarvis.service (start at boot)..."
sudo systemctl enable jarvis.service

cat <<EOF

Installed. Useful commands:

  sudo systemctl start jarvis      # start now
  sudo systemctl status jarvis     # check status
  sudo systemctl restart jarvis    # apply code changes after pnpm run build
  journalctl -fu jarvis            # follow logs

If you'd been running JARVIS as a foreground process, kill it before
starting the service so two copies don't fight over Telegram polling.
EOF
