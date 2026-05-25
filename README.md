# JARVIS

JARVIS is a personal AI assistant for Telegram, designed to run as a long-lived service on a trusted Linux host.

It combines a Telegram chat interface with persistent sessions, filesystem memory, scheduled jobs, background workers, full host shell access, and a deliberately small tool surface. The core design principle is simple: source code is replaceable; local state is not.

```text
~/jarvis/   source code, git-managed, disposable
~/.jarvis/  host-local config, secrets, prompts, memory, sessions, logs, jobs
```

## Features

- **Telegram-first interface** with hard allowlisting by numeric Telegram user ID.
- **Persistent per-chat sessions** stored as JSONL, with rotation, compaction, and session summaries.
- **Filesystem memory** in Markdown notes under `~/.jarvis/data/notes/`.
- **Five built-in tools:** file read/write/edit, shell, and Exa-backed web search/page fetch.
- **Image input** from Telegram photos or image documents, including captions as prompts.
- **Scheduled jobs** with cron-style recurring tasks, one-time reminders, independent transcripts, notes, and notifications.
- **Background workers** for long-running tasks, using isolated git worktrees and role pipelines such as `researcher -> implementer -> reviewer`.
- **Safe deploy flow** that builds before restart, announces restart/back-online status, and avoids killing an in-flight chat response.
- **Operational logging** through journald plus an append-only, redacted tool-call audit log.

## Architecture

```text
Telegram
  │
  ▼
src/transport/telegram.ts      allowlist, commands, typing, streaming, image download
  │
  ▼
src/agent/runtime.ts           pi-agent-core Agent, model, tools, sessions, cancellation
  │
  ├─ src/agent/session-manager.ts  JSONL sessions, rotation, archive
  ├─ src/agent/compaction.ts       context compaction
  ├─ src/agent/summarizer.ts       recent.md session TOC updates
  ├─ src/agent/tools/              read, write, edit, bash, web_search
  ├─ src/scheduler.ts              recurring and one-time scheduled jobs
  └─ src/background/               detached worker tasks and pipelines
```

Runtime configuration is loaded once at startup from:

- `~/.jarvis/config.yaml` — non-secret tunables, validated with Zod.
- `~/.jarvis/.env` — secrets, loaded by systemd via `EnvironmentFile=` or by `node --env-file` in foreground runs.

The system prompt is loaded verbatim from `~/.jarvis/prompts/system.md`. Memory is not injected automatically; JARVIS reads Markdown notes on demand according to the prompt rules.

## Requirements

- Linux host with outbound network access.
- Node.js 20+; Node 22 is used on the live host.
- pnpm 10+.
- Telegram bot token from [@BotFather](https://t.me/BotFather).
- Numeric Telegram user ID(s) for the allowlist.
- Exa API key for the `web_search` tool.
- One model provider:
  - Codex OAuth credentials for `agent.provider: codex`, or
  - `ANTHROPIC_API_KEY` for `agent.provider: anthropic`.

## Fresh host setup

Clone the repo and bootstrap the data tree:

```bash
git clone git@github.com:jackgladowsky/jarvis.git ~/jarvis
cd ~/jarvis
scripts/setup-host.sh
```

`setup-host.sh` is idempotent. It creates `~/.jarvis/`, copies templates only when missing, installs dependencies, builds the TypeScript project, and tightens permissions on `~/.jarvis/.env`.

Edit the host-local files:

```bash
$EDITOR ~/.jarvis/.env                  # secrets
$EDITOR ~/.jarvis/config.yaml           # non-secret tunables
$EDITOR ~/.jarvis/AGENTS.md             # authoritative host notes
$EDITOR ~/.jarvis/prompts/system.md     # live system prompt
chmod 600 ~/.jarvis/.env
```

Run in the foreground:

```bash
cd ~/jarvis
node --env-file=$HOME/.jarvis/.env dist/index.js
```

Install as a systemd service:

```bash
cd ~/jarvis
scripts/install-systemd.sh
sudo systemctl start jarvis
sudo systemctl status jarvis
journalctl -fu jarvis
```

The installer writes `/etc/systemd/system/jarvis.service` and `/etc/logrotate.d/jarvis` using the current user, repo path, Node binary, and data directory. It enables the service at boot but does not start it for you.

## Configuration

Important environment variables in `~/.jarvis/.env`:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
EXA_API_KEY=
CODEX_OAUTH_CREDS_PATH=        # optional; defaults under ~/.jarvis
ANTHROPIC_API_KEY=             # optional, used by the anthropic provider
```

Important `~/.jarvis/config.yaml` sections:

- `agent` — provider and model.
- `session` — inactivity and max-duration rotation thresholds.
- `compaction` — context compaction thresholds.
- `tools.bash` — default and maximum shell timeouts.
- `telegram` — typing indicator and parse mode.
- `scheduler` — enablement, timezone, notification chat, bootstrap tasks.
- `logging` — audit log behavior, redaction, truncation, log level.

See `config.yaml.example` and `.env.example` for the full schema. Config is frozen at startup; restart the service to apply changes.

## Telegram interface

JARVIS responds to normal text messages from allowlisted users. It also accepts Telegram photos and image documents:

- Up to 4 image candidates per message.
- 10 MB maximum per image.
- Captions are used as the prompt.
- If an image arrives without text, the default prompt is “Describe the attached image(s).”

Commands handled by the transport layer:

```text
/new                  force-rotate the current chat session
/cancel               abort the currently running agent turn for this chat
/thinking [on|off]    show coarse progress updates for future turns
/verbose [on|off]     show more detailed progress/tool updates for future turns
/usage                show local context and token/cost usage estimates

/bg <prompt>          start a background worker task
/tasks                list recent background tasks
/task <id>            show task status and recent mailbox entries
/answer <id> <text>   answer a worker question and resume it
/fixbg <id> [role]    resume a needs-fix task on the same worktree
/cancelbg <id>        cancel a background worker task
```

The user-visible response path is intentionally quiet: Telegram shows typing while work is in progress, then streams the final answer via debounced message edits. Tool-call messages and filler text are hidden.

## Scheduled jobs

Enable the scheduler in `~/.jarvis/config.yaml`:

```yaml
scheduler:
  enabled: true
  timezone: America/New_York
  telegram_chat_id: 123456789
  tasks: []
```

There are two task sources:

- Static/bootstrap tasks in `scheduler.tasks` inside `config.yaml`.
- Dynamic tasks in `~/.jarvis/data/jobs/tasks.json`, hot-reloaded roughly every 30 seconds.

Recurring tasks use `schedule` with a cron expression. One-time tasks use `run_at` with an absolute timestamp including timezone/offset, and are removed after they run.

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

`notify` may be `always`, `on_issue`, or `never`. Each task has its own transcript and note under `~/.jarvis/data/jobs/`, plus scheduler logs at `~/.jarvis/data/jobs/scheduler.log`.

## Background workers

Long-running work can be moved out of the main Telegram chat:

```text
/bg <prompt>
```

A worker task gets:

- A friendly task id, branch, and git worktree under `~/jarvis-worktrees/<task-id>`.
- Task JSON under `~/.jarvis/data/background/tasks/`.
- A task note under `~/.jarvis/data/background/notes/`.
- A mailbox JSONL under `~/.jarvis/data/background/mail/`.
- A persistent background session under `~/.jarvis/data/background/sessions/`.

Tasks run as pipelines selected from the prompt. Common shapes are:

```text
implementer -> reviewer
researcher -> reviewer
researcher -> implementer -> reviewer
```

Reviewers do not edit files. They mark work `ready_for_pr` or `needs_fix`; main JARVIS remains the gate for inspecting, pushing, opening PRs, merging, or deploying.

Shell entrypoints:

```bash
scripts/start-background-task.sh "Implement the thing"
scripts/resume-background-task.sh <task-id> [fixer|reviewer]
```

Background worker cleanup is handled by a dry-run-first janitor script:

```bash
scripts/cleanup-background-worktrees.sh --dry-run
scripts/cleanup-background-worktrees.sh --apply --age-days 14
```

The script removes only old terminal task worktrees (`ready_for_pr`, `cancelled`, `failed`, `done`) and keeps task JSON, notes, mail, sessions, and logs. It prunes stale git worktree metadata, reports filesystem orphans under `~/jarvis-worktrees/`, and skips dirty worktrees unless `--force-dirty` is explicitly set. Branch deletion is opt-in with `--delete-branches` and only deletes merged local `worker/*` branches unless `--force-branches` is also set.

Suggested weekly scheduled janitor task:

```json
{
  "id": "weekly-janitor",
  "name": "Weekly Janitor",
  "schedule": "0 9 * * 1",
  "notify": "always",
  "prompt": "Run `cd ~/jarvis && scripts/cleanup-background-worktrees.sh --dry-run --age-days 14`, report what would be cleaned, identify stale todos/docs/notes, and do not delete ambiguous notes or data without Jack's approval."
}
```

## Data layout

By default, data lives under `~/.jarvis/`. Override with `JARVIS_DATA_DIR` for development or testing.

```text
~/.jarvis/
├── .env                         secrets; chmod 600
├── .codex-creds.json            default Codex OAuth credential path
├── config.yaml                   runtime config
├── AGENTS.md                     host/environment notes
├── prompts/system.md             live system prompt
├── data/audit.log                tool-call audit log
├── data/sessions/                chat sessions
│   ├── active.json
│   └── archive/
├── data/notes/                   filesystem memory
│   ├── about.md
│   ├── environment.md
│   ├── recent.md
│   ├── decisions.md
│   ├── todo.md
│   ├── preferences.md
│   └── projects/
├── data/jobs/                    scheduled job state
│   ├── tasks.json
│   ├── sessions/
│   ├── notes/
│   └── scheduler.log
├── data/background/              worker state
│   ├── tasks/
│   ├── sessions/
│   ├── notes/
│   ├── mail/
│   ├── bootstrap.log
│   └── worker-errors.log
└── data/deploy/                  safe-deploy markers and restart log
```

Everything under `~/.jarvis/` is host-local and should not be committed. Everything under `~/jarvis/` should be replaceable from git.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run build
node --env-file=$HOME/.jarvis/.env dist/index.js
```

For a sandbox data directory:

```bash
JARVIS_DATA_DIR=$PWD/.jarvis-dev scripts/setup-host.sh
JARVIS_DATA_DIR=$PWD/.jarvis-dev node --env-file=$PWD/.jarvis-dev/.env dist/index.js
```

Useful repo checks:

```bash
pnpm run typecheck
pnpm run build
git diff --check
```

## Deploy and update

For an installed host, prefer the safe deploy flow:

```bash
cd ~/jarvis
scripts/safe-deploy.sh              # defaults to origin/main
scripts/safe-deploy.sh origin/main  # explicit target
```

`safe-deploy.sh`:

1. Refuses to run with a dirty working tree.
2. Fetches and fast-forwards to the target ref.
3. Installs dependencies and builds.
4. Leaves the running service untouched if the build fails.
5. Sends a Telegram restart notice, writes a pending deploy marker, and schedules a short delayed `systemctl restart` so the chat response can finish.
6. Sends a back-online notice on startup.

`scripts/update.sh` is a backwards-compatible alias for `safe-deploy.sh`.

Use raw systemd restarts for deliberate manual service/config operations, not as the normal code deploy path:

```bash
sudo systemctl restart jarvis
```


## Operations

```bash
sudo systemctl status jarvis
journalctl -fu jarvis
tail -f ~/.jarvis/data/audit.log
tail -f ~/.jarvis/data/jobs/scheduler.log
tail -f ~/.jarvis/data/background/bootstrap.log
```

Other useful scripts:

```bash
scripts/backup-jarvis-data.sh
scripts/install-systemd.sh
scripts/setup-host.sh
scripts/start-background-task.sh "prompt"
```

The systemd installer configures logrotate for `~/.jarvis/data/audit.log` with daily rotation, 30 retained compressed logs, and `copytruncate`.

## Safety and security posture

JARVIS is designed for a trusted, single-user machine. It has real shell access and is expected to use it. Access control is the Telegram allowlist plus host-level secret hygiene, not a sandbox.

Protect these files carefully:

- `~/.jarvis/.env`
- `~/.jarvis/.codex-creds.json`
- `~/.jarvis/config.yaml`
- `~/.jarvis/prompts/system.md`
- `~/.jarvis/data/`

The audit log records tool calls with redaction and truncation. It is an accountability mechanism, not a permission system. Do not expose the bot token, OAuth credentials, Exa key, Anthropic key, or host-local data.
