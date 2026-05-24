# JARVIS

Personal AI assistant for Telegram, running as a long-lived service on a Linux host.

JARVIS is built around a simple split:

- `~/jarvis/` — source code, git-managed and disposable.
- `~/.jarvis/` — host-local config, secrets, prompts, memory, sessions, audit logs, and scheduled-job state.

The assistant uses `pi-agent-core` for the agent loop, Telegram for chat, Codex OAuth by default for model access, and a deliberately small set of tools: file read/write/edit, shell, and web search.

## Features

- Telegram bot interface with hard allowlisting by Telegram user ID.
- Persistent per-chat sessions with JSONL transcripts and rotation summaries.
- Filesystem-based memory in Markdown notes.
- Full shell access on the host, with audit logging for tool calls.
- Web search and page fetch through Exa.
- Optional recurring scheduled jobs with independent transcripts and notes.
- Systemd deployment scripts for running as a boot-started service.

## Repository layout

```text
.
├── src/                    TypeScript source
│   ├── agent/              Agent runtime, sessions, compaction, auth
│   ├── transport/          Telegram transport
│   ├── lib/                Formatting, logging, mutexes, allowlists
│   ├── config.ts           YAML/env config validation
│   ├── paths.ts            Central data-tree paths
│   ├── scheduler.ts        Recurring scheduled task runner
│   └── index.ts            Process entrypoint
├── prompts/                Example system prompt
├── scripts/                Setup, systemd install, update scripts
├── AGENTS.md.example       Host facts template
├── config.yaml.example     Non-secret config template
├── .env.example            Secret env template
└── DESIGN.md               Architecture and rationale
```

## Requirements

- Linux host
- Node.js 20+
- pnpm 10+
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Telegram numeric user ID for the allowlist
- Exa API key for `web_search`
- One model provider:
  - Codex OAuth credentials for the default `codex` provider, or
  - `ANTHROPIC_API_KEY` with `agent.provider: anthropic`

## Fresh host setup

Clone the repo, then bootstrap the data tree:

```bash
git clone git@github.com:jackgladowsky/jarvis.git ~/jarvis
cd ~/jarvis
scripts/setup-host.sh
```

That creates `~/.jarvis/` without overwriting existing live files, installs dependencies, and builds the project.

Then edit the host-local files:

```bash
$EDITOR ~/.jarvis/.env          # secrets
$EDITOR ~/.jarvis/config.yaml   # non-secret tunables
$EDITOR ~/.jarvis/AGENTS.md     # authoritative host notes
$EDITOR ~/.jarvis/prompts/system.md
chmod 600 ~/.jarvis/.env
```

Run locally:

```bash
cd ~/jarvis
node --env-file=$HOME/.jarvis/.env dist/index.js
```

Or install as a systemd service:

```bash
cd ~/jarvis
scripts/install-systemd.sh
sudo systemctl start jarvis
sudo systemctl status jarvis
journalctl -fu jarvis
```

## Configuration

JARVIS loads two sources at startup:

- `~/.jarvis/config.yaml` — non-secret tunables, validated with Zod.
- `~/.jarvis/.env` — secrets, loaded by systemd via `EnvironmentFile=` or by `node --env-file` in foreground runs.

Changes require a restart:

```bash
sudo systemctl restart jarvis
```

Important environment variables:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
EXA_API_KEY=
CODEX_OAUTH_CREDS_PATH=        # optional; defaults under ~/.jarvis
ANTHROPIC_API_KEY=             # optional fallback provider
```

See `config.yaml.example` and `.env.example` for the full shape.

## Data layout

By default, data lives under `~/.jarvis/`. Override with `JARVIS_DATA_DIR` for development or testing.

```text
~/.jarvis/
├── .env                         Secrets; chmod 600
├── config.yaml                   Runtime config
├── AGENTS.md                     Host/environment notes
├── prompts/system.md             System prompt
├── data/audit.log                Tool-call audit log
├── data/sessions/                Chat sessions
│   ├── active.json
│   └── archive/
├── data/notes/                   Filesystem memory
│   ├── about.md
│   ├── environment.md
│   ├── recent.md
│   ├── decisions.md
│   ├── todo.md
│   ├── preferences.md
│   └── projects/
└── data/jobs/                    Scheduled job state
    ├── tasks.json
    ├── sessions/
    ├── notes/
    └── scheduler.log
```

## Scheduled jobs

Enable the scheduler in `~/.jarvis/config.yaml`:

```yaml
scheduler:
  enabled: true
  timezone: America/New_York
  telegram_chat_id: 123456789
  tasks: []
```

Dynamic tasks live in `~/.jarvis/data/jobs/tasks.json` and are hot-reloaded roughly every 30 seconds. Recurring tasks use `schedule` (cron). One-time tasks/reminders use `run_at` (absolute timestamp with timezone/offset) and are removed from the file after they run.

```json
{
  "tasks": [
    {
      "id": "morning-newsletter",
      "name": "Morning Newsletter",
      "schedule": "0 7 * * *",
      "notify": "always",
      "prompt": "Write Jack a concise morning newsletter."
    },
    {
      "id": "call-mom",
      "name": "Call Mom Reminder",
      "run_at": "2026-05-11T17:00:00-04:00",
      "notify": "always",
      "prompt": "Remind Jack to call Mom."
    }
  ]
}
```

Each task gets its own transcript and note file under `~/.jarvis/data/jobs/`.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm start
```

For a sandbox data directory:

```bash
JARVIS_DATA_DIR=$PWD/.jarvis-dev scripts/setup-host.sh
JARVIS_DATA_DIR=$PWD/.jarvis-dev node --env-file=$PWD/.jarvis-dev/.env dist/index.js
```

## Deploy/update

After changing code locally:

```bash
pnpm run build
sudo systemctl restart jarvis
```

For a clean pull/build/restart flow on an installed host:

```bash
scripts/safe-deploy.sh
```

`safe-deploy.sh` refuses to run with a dirty working tree and will not restart the service unless the new code builds. If it does restart, it sends a Telegram "restarting" notice, writes a pending deploy marker, schedules the restart after a short delay, and JARVIS sends a back-online notice on startup. `scripts/update.sh` remains as a backwards-compatible alias.

## Operations

Useful commands:

```bash
sudo systemctl status jarvis
sudo systemctl restart jarvis
journalctl -fu jarvis
tail -f ~/.jarvis/data/audit.log
tail -f ~/.jarvis/data/jobs/scheduler.log
```

The systemd installer also configures logrotate for `~/.jarvis/data/audit.log`.

## Security posture

This is a personal assistant designed for a trusted single-user machine. It has real shell access and is meant to use it. Access control is the Telegram allowlist plus host-level secrets management, not a sandbox.

Do not expose this bot token, `.env`, OAuth credentials, or `~/.jarvis/` data. The source repo should remain free of host-local data and secrets.
