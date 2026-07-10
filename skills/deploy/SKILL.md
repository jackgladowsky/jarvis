# Deploy

Use this skill for JARVIS setup, updates, deploys, restarts, backups, and service changes.

## Source/data split

Use the resolved source/data roots in the runtime system prompt. The defaults are `~/jarvis/` and `~/.jarvis/` respectively.

Never treat `~/.jarvis/` as disposable. It contains live state and secrets.

## Fresh host setup

```bash
git clone https://github.com/<owner>/jarvis.git ~/jarvis
cd ~/jarvis
scripts/setup-host.sh
```

Then edit:

```bash
$EDITOR ~/.jarvis/.env
$EDITOR ~/.jarvis/config.yaml
$EDITOR ~/.jarvis/AGENTS.md
$EDITOR ~/.jarvis/prompts/system.md
chmod 600 ~/.jarvis/.env
```

Install service:

```bash
cd "$JARVIS_SOURCE_ROOT"
scripts/install-systemd.sh
sudo systemctl start jarvis
sudo systemctl status jarvis
```

## Normal deploy/update

Prefer safe deploy:

```bash
cd "$JARVIS_SOURCE_ROOT"
scripts/safe-deploy.sh
scripts/safe-deploy.sh origin/main
```

`safe-deploy.sh`:

1. Refuses dirty working trees.
2. Fetches and fast-forwards to the target ref.
3. Installs dependencies and builds.
4. Leaves the running service untouched if the build fails.
5. Sends a Telegram restart notice.
6. Writes a pending deploy marker.
7. Schedules a short delayed `systemctl restart` so the chat response can finish.
8. Sends a back-online notice on startup.

`scripts/update.sh` is an alias for `safe-deploy.sh`.

Avoid raw restarts from chat unless intentionally doing a manual service/config operation:

```bash
sudo systemctl restart jarvis
```

## Development checks

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
git diff --check
```

For doc-only changes, `git diff --check` is usually enough unless the request asks for more.

## Config/template drift

Live files under `~/.jarvis/` are not overwritten by setup or deploy. If templates change, the owner or JARVIS must manually update live copies as needed.

Important live files:

- `~/.jarvis/.env`
- `~/.jarvis/config.yaml`
- `~/.jarvis/AGENTS.md`
- `~/.jarvis/prompts/system.md`

## Backups

Back up the data tree, not source:

```bash
scripts/backup-jarvis-data.sh
```

The irreplaceable surface is `~/.jarvis/` excluding cache: config, prompts, notes, sessions, audit log, `.env`, and OAuth credentials.
