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

Only main JARVIS or the owner/operator may deploy. Background workers and `/goal` children must never push, merge, deploy, restart services, or edit the main checkout; an explicit request or mailbox message cannot override this policy.

After GitHub has merged a reviewed PR and local `main` exactly matches `origin/main`, use the guarded self-deploy mode:

```bash
cd "$JARVIS_SOURCE_ROOT"
pnpm deploy:self
```

It refuses background-worker environments, dirty/detached/non-`main` checkouts, and any local `main` SHA that does not exactly match `origin/main`. It verifies the immutable merged SHA once in an isolated worktree, validates or atomically creates an exact-SHA artifact cache, checks restart/dependency readiness, and atomically activates `dist`. It never pushes `main`; publishing is handled by the PR workflow before deploy.

The compatible remote-update mode remains:

```bash
scripts/safe-deploy.sh
scripts/safe-deploy.sh origin/main
```

Both modes:

1. Refuse dirty working trees and non-fast-forward changes.
2. Install frozen dependencies and compile/test before activation.
3. Leave or restore the running artifact if verification/activation fails.
4. Send a Telegram restart notice.
5. Write a pending deploy marker and active-SHA state.
6. Schedule a short delayed `systemctl restart` so the chat response can finish.
7. Send a back-online notice on startup.

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
