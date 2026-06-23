# JARVIS

Self-hosted Telegram AI assistant for a trusted Linux box. JARVIS combines a chat interface with persistent local state, filesystem memory, scheduled jobs, background workers, shell access, and a deliberately small tool surface.

The load-bearing design choice is separation between disposable source and host-local state:

```text
~/jarvis/   source code, git-managed, safe to replace
~/.jarvis/  host-local config, secrets, prompts, memory, sessions, logs, jobs
```

## Features

- Telegram bot interface with hard allowlisting by numeric Telegram user ID.
- Persistent JSONL sessions with rotation, archival, and summaries.
- Markdown memory notes under `~/.jarvis/data/notes/`.
- Five built-in tools: read, write, edit, bash, and Exa-backed web search/fetch.
- Telegram image input and optional local whisper.cpp voice/audio transcription.
- Cron-style recurring scheduled jobs plus one-time reminders.
- Detached background workers using isolated git worktrees and role pipelines.
- Safe deploy helper that builds before restart and preserves host-local data.
- Append-only redacted audit log for tool calls.
- Repo-local procedural skills in `SKILLS.md` and `skills/*/SKILL.md`.

## Requirements

- Linux host with outbound network access.
- Node.js 20+ and pnpm 10+.
- Telegram bot token from [@BotFather](https://t.me/BotFather).
- Numeric Telegram user ID(s) for the allowlist.
- Exa API key for the `web_search` tool.
- One model provider:
  - Codex OAuth credentials for `agent.provider: codex`, or
  - `ANTHROPIC_API_KEY` for `agent.provider: anthropic`.

## Quick start

```bash
git clone https://github.com/<owner>/jarvis.git ~/jarvis
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

The systemd installer writes `/etc/systemd/system/jarvis.service` and `/etc/logrotate.d/jarvis` using the current user, repo path, Node binary, and data directory. It enables the service at boot but does not start it for you.

## One-command installer preview

This repo includes an interactive first-run installer intended for curl-based onboarding:

```bash
curl -fsSL https://raw.githubusercontent.com/jackgladowsky/jarvis/main/scripts/install.sh | bash
```

For local testing, forks, or automation:

```bash
JARVIS_REPO_URL=https://github.com/<owner>/jarvis.git bash scripts/install.sh
scripts/install.sh --dry-run --skip-systemd
scripts/install.sh --install-dir ~/jarvis --data-dir ~/.jarvis --skip-systemd
```

The installer clones or reuses the repo, bootstraps `~/.jarvis`, prompts for required secrets/config values via `/dev/tty` so `curl | bash` can still be interactive, builds the project, and optionally installs the systemd unit. It does **not** start the service automatically. Use `--dry-run` to preview and `--skip-systemd` to leave service installation for later.

## Configuration

Secrets live in `~/.jarvis/.env`; non-secret tunables live in `~/.jarvis/config.yaml`. See `.env.example` and `config.yaml.example` for the full schema.

Important environment variables:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USER_IDS=
EXA_API_KEY=
CODEX_OAUTH_CREDS_PATH=        # optional; defaults under ~/.jarvis
ANTHROPIC_API_KEY=             # optional, used by the anthropic provider
```

Important config sections:

- `agent` — provider and model.
- `session` — inactivity and max-duration rotation thresholds.
- `compaction` — context compaction thresholds.
- `tools.bash` — default and maximum shell timeouts.
- `telegram` — typing indicator and parse mode.
- `stt` — optional local whisper.cpp speech-to-text for Telegram voice/audio.
- `scheduler` — enablement, timezone, notification chat, bootstrap tasks.
- `logging` — audit log behavior, redaction, truncation, log level.

Config is loaded once at startup; restart JARVIS to apply changes.

## Telegram commands

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
/goal start [opts] <objective>  start a bounded autonomous improvement loop
/goal list|status|log <id>      inspect goal state/events
/goal pause|resume|stop|next <id> control a goal loop
```

## Local whisper.cpp speech-to-text

Install whisper.cpp and a local model, then point `~/.jarvis/config.yaml` at them:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake git ffmpeg
mkdir -p ~/.jarvis/models ~/projects
cd ~/projects
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j"$(nproc)"
./models/download-ggml-model.sh base.en
cp models/ggml-base.en.bin ~/.jarvis/models/
```

Example config:

```yaml
stt:
  provider: local-whisper-cpp
  local_whisper_cpp:
    whisper_binary_path: /home/your-user/projects/whisper.cpp/build/bin/whisper-cli
    model_path: /home/your-user/.jarvis/models/ggml-base.en.bin
    ffmpeg_path: /usr/bin/ffmpeg
    max_audio_mb: 25
    timeout_seconds: 120
```

## Autonomous goals

`/goal` is a bounded controller over background workers, not a permission bypass or infinite agent loop. `/goal start [--max-tasks N] [--max-minutes N] [--max-failures N] [--auto] <objective>` creates persistent state under `~/.jarvis/data/goals/` and launches one child background task at a time. Defaults are intentionally conservative: one task, two hours, zero failures, and no auto-continue. A goal stops or waits when task/time/failure budget is exhausted, a child task needs fixes or main approval, or Jack pauses/stops it. Child tasks are still forbidden from push/merge/deploy/restart/destructive operations without explicit approval, and all goal transitions append JSONL events for auditability.

## Development

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
```

`pnpm run check` runs format check, lint, typecheck, and coverage.

CI runs on pushes to `main` and pull requests using Node 20 and 22.

## Security model

JARVIS is designed for a trusted single-owner host. It has shell access, can edit files, and can operate system tools exposed to the Unix user running it. Do not deploy it on a machine where arbitrary command execution by the assistant is unacceptable.

Protect these host-local files carefully:

- `~/.jarvis/.env`
- `~/.jarvis/.codex-creds.json`
- `~/.jarvis/config.yaml`
- `~/.jarvis/data/`

Repo updates and setup scripts should never overwrite existing host-local files unless you explicitly edit them.

## Roadmap notes

- See `docs/open-source-hardening.md` for the remaining productionization backlog.
- See `docs/goal-command.md` for the bounded `/goal` command/autonomous improvement loop design.

## License

MIT. See [LICENSE](LICENSE).
