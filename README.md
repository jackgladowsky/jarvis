# JARVIS

JARVIS is a self-hosted Telegram AI assistant for a trusted Linux machine. It gives an allowlisted Telegram user a high-agency assistant with local memory, scheduled jobs, background workers, web search, and real shell/filesystem access on the host.

If you want a private assistant you can run on your own box, start here. If you want a multi-user SaaS bot or something safe to expose to strangers, this is not that — JARVIS is intentionally powerful and should only run for users you trust.

## Install in one command

Prereqs on the target Linux host:

- `bash`, `git`, and `python3`
- Node.js 20+; pnpm is installed through Corepack if needed
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram user ID for the allowlist
- Exa API key for web search
- A model provider credential: Codex OAuth creds or `ANTHROPIC_API_KEY`

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/jackgladowsky/jarvis/main/scripts/install.sh | bash
```

The installer is interactive and idempotent. It:

1. Clones or reuses `~/jarvis`.
2. Creates host-local state under `~/.jarvis`.
3. Prompts for Telegram, Exa, model, and timezone settings via `/dev/tty` so `curl | bash` is still interactive.
4. Installs dependencies and builds the TypeScript project.
5. Optionally installs/enables a `jarvis.service` systemd unit.

It does **not** start the service automatically. After it finishes:

```bash
# sanity-check generated config/secrets
$EDITOR ~/.jarvis/.env
$EDITOR ~/.jarvis/config.yaml

# start if you accepted systemd install
sudo systemctl start jarvis
sudo systemctl status jarvis
journalctl -fu jarvis
```

You should then be able to message your Telegram bot from an allowlisted account.

### Installer variants

```bash
# Preview actions without writing files
curl -fsSL https://raw.githubusercontent.com/jackgladowsky/jarvis/main/scripts/install.sh | bash -s -- --dry-run

# Install without touching systemd
curl -fsSL https://raw.githubusercontent.com/jackgladowsky/jarvis/main/scripts/install.sh | bash -s -- --skip-systemd

# Use a fork, branch, custom source dir, or custom data dir
curl -fsSL https://raw.githubusercontent.com/jackgladowsky/jarvis/main/scripts/install.sh | bash -s -- \
  --repo-url https://github.com/<owner>/jarvis.git \
  --branch main \
  --install-dir ~/jarvis \
  --data-dir ~/.jarvis
```

### Manual install

If you do not want to pipe a script from the network:

```bash
git clone https://github.com/jackgladowsky/jarvis.git ~/jarvis
cd ~/jarvis
scripts/setup-host.sh
$EDITOR ~/.jarvis/.env
$EDITOR ~/.jarvis/config.yaml
scripts/install-systemd.sh     # optional
sudo systemctl start jarvis    # if systemd was installed
```

## What gets installed

JARVIS keeps source and private runtime data separate:

```text
~/jarvis/   source code, git-managed, safe to replace
~/.jarvis/  host-local config, secrets, prompts, memory, sessions, logs, jobs
```

The installer never commits or uploads `~/.jarvis`. Existing host-local files are preserved unless you explicitly edit/overwrite them in the wizard.

## Features

- Telegram bot interface with hard allowlisting by numeric Telegram user ID.
- Persistent JSONL sessions with rotation, archival, and summaries.
- Markdown memory notes under `~/.jarvis/data/notes/`.
- Built-in tools: read, write, edit, bash, Exa-backed web search/fetch, and read-only browser workbench.
- Telegram image input and optional local whisper.cpp voice/audio transcription.
- Initial local-only Playwright browser workbench for read-only page inspection with persistent profile, screenshots, and JSON artifacts.
- Cron-style recurring scheduled jobs plus one-time reminders.
- Detached background workers using isolated git worktrees and role pipelines.
- Safe deploy helper that builds before restart and preserves host-local data.
- Append-only redacted audit log for tool calls.
- Repo-local procedural skills in `SKILLS.md` and `skills/*/SKILL.md`.

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

## Browser workbench

The first browser workbench slice is local-only and read-only. The `browser_workbench` agent tool can open a public `http(s)` URL in a persistent Chromium profile, capture title/visible text, and write screenshots/JSON artifacts under `~/.jarvis/data/workbench/`. It blocks local/private URLs and includes hard approval gates for purchase/order/booking/send/post/delete/cancel/account/financial/legal/medical requests.

Smoke test:

```bash
pnpm exec playwright install chromium   # if the browser binary is not installed yet
pnpm run workbench:smoke -- https://example.com
```

See `docs/workbench.md` for data paths, safety notes, and current limitations. CAPTCHA bypass, login/2FA automation, side-effect actions, Docker Compose packaging, and noVNC/KasmVNC human takeover are not implemented in this first slice.

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

`/goal` is a bounded controller over background workers, not a permission bypass or infinite agent loop. `/goal start [--max-tasks N] [--max-minutes N] [--max-failures N] [--auto] <objective>` creates persistent state under `~/.jarvis/data/goals/` and launches one child background task at a time. Defaults are intentionally conservative: one task, two hours, zero failures, and no auto-continue. A goal stops or waits when task/time/failure budget is exhausted, a child task needs fixes or main approval, or the owner pauses/stops it. Child tasks are still forbidden from push/merge/deploy/restart/destructive operations without explicit approval, and all goal transitions append JSONL events for auditability.

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
