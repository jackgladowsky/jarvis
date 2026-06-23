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
- **Voice/audio input** from Telegram, transcribed locally with whisper.cpp when configured.
- **Scheduled jobs** with cron-style recurring tasks, one-time reminders, independent transcripts, notes, and notifications.
- **Background workers** for long-running tasks, using isolated git worktrees and role pipelines such as `researcher -> implementer -> reviewer`.
- **Safe deploy flow** that builds before restart, announces restart/back-online status, and avoids killing an in-flight chat response.
- **Operational logging** through journald plus an append-only, redacted tool-call audit log.
- **Skills convention** with `SKILLS.md` and `skills/*/SKILL.md` for detailed procedures read on demand.

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

The system prompt is loaded verbatim from `~/.jarvis/prompts/system.md`. It stays concise and points JARVIS to repo-local skills in `SKILLS.md` / `skills/*/SKILL.md` for detailed procedures. Memory is not injected automatically; JARVIS reads Markdown notes on demand according to the memory skill.

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
- `stt` — optional local whisper.cpp speech-to-text for Telegram voice/audio.
- `scheduler` — enablement, timezone, notification chat, bootstrap tasks.
- `logging` — audit log behavior, redaction, truncation, log level.

See `config.yaml.example` and `.env.example` for the full schema. Config is frozen at startup; restart the service to apply changes.

### Local whisper.cpp speech-to-text

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
    whisper_binary_path: /home/jack/projects/whisper.cpp/build/bin/whisper-cli
    model_path: /home/jack/.jarvis/models/ggml-base.en.bin
    ffmpeg_path: /usr/bin/ffmpeg
    max_audio_mb: 25
    timeout_seconds: 120
```

Telegram voice notes are usually Ogg/Opus, so keep `ffmpeg_path` set unless you only plan to send WAV files. Restart JARVIS after editing config.

## Telegram interface

JARVIS responds to normal text messages from allowlisted users. It also accepts Telegram photos and image documents:

- Up to 4 image candidates per message.
- 10 MB maximum per image.
- Captions are used as the prompt.
- If an image arrives without text, the default prompt is “Describe the attached image(s).”

It accepts Telegram voice notes and audio files when `stt.provider: local-whisper-cpp` is configured:

- Audio is downloaded transiently, optionally converted to 16 kHz mono WAV with `ffmpeg`, and transcribed with local `whisper-cli`/`whisper.cpp`.
- No OpenAI API key or hosted transcription service is used.
- `stt.local_whisper_cpp.max_audio_mb` and `timeout_seconds` cap file size and runtime.
- The transcript is fed through the normal chat path with a `[Transcribed ...]` prefix. Captions are preserved below `[Caption]`.
- If setup is missing, JARVIS replies with a clear setup error instead of running the agent.

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

## Skills convention

Procedural instructions live in repo-local skill files so the core system prompt stays small:

```text
SKILLS.md                    skill index and convention
skills/<slug>/SKILL.md       one procedural skill per directory
```

JARVIS reads the relevant skill on demand before work in that area; it does not load every skill by default. Initial skills cover background workers, deploys, scheduler, memory, destinations, GitHub PRs, host ops, web search, and deep research.

## Destination recommendations and ride links

Detailed destination and rideshare policy lives in `skills/destinations/SKILL.md`. In short: use web search when local/current options matter, recommend the best fit concisely, include Google Maps plus Uber/Lyft web links when coordinates/address are available, and do not claim live rideshare prices without a supplied source.

## Scheduled jobs

Detailed scheduler procedure lives in `skills/scheduler/SKILL.md`. The scheduler supports built-in recurring tasks, static tasks in `~/.jarvis/config.yaml`, and dynamic recurring/one-time tasks in `~/.jarvis/data/jobs/tasks.json`, with per-task sessions, notes, and logs under `~/.jarvis/data/jobs/`.

Built-in task: `nightly-memory-review` runs at `30 2 * * *` in the configured scheduler timezone. It reviews the previous America/New_York day's session summaries/logs and conservatively updates persistent memory notes. It uses `notify: on_issue` and emits an explicit `NOTIFY: yes|no` marker so normal no-op runs stay quiet. Config or dynamic tasks with the same id override the built-in definition.

## Internal notifications

Background workers, scheduler jobs, and deploy notices enqueue internal notification JSON under `~/.jarvis/data/notifications/`. The main Telegram process polls that queue and turns each notification into a normal main-session prompt, so Jack receives JARVIS's response in the same conversation and transcript instead of a raw automated bot message. The pump writes `heartbeat.json`; if producers do not see a fresh heartbeat, they fall back to direct Telegram for emergency visibility.

## Background workers

Detailed background-worker procedure lives in `skills/background-workers/SKILL.md`. Long-running work can be delegated with `/bg <prompt>` or `scripts/start-background-task.sh "<prompt>"`; tasks use isolated worktrees under `~/jarvis-worktrees/` and state under `~/.jarvis/data/background/`. Reviewers mark work `ready_for_pr` or `needs_fix`; main JARVIS remains the PR/deploy gate.

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
├── data/notifications/           internal notification queue + heartbeat
│   └── archive/
└── data/deploy/                  safe-deploy markers and restart log
```

Everything under `~/.jarvis/` is host-local and should not be committed. Everything under `~/jarvis/` should be replaceable from git. Repo-local procedural skills live in `~/jarvis/SKILLS.md` and `~/jarvis/skills/`.

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

Detailed deploy procedure lives in `skills/deploy/SKILL.md`. For installed hosts, prefer `scripts/safe-deploy.sh`; it refuses dirty trees, fast-forwards, installs dependencies, builds, queues restart/back-online notices through internal notifications with Telegram fallback, and schedules a delayed service restart so the chat response can complete. Use raw `sudo systemctl restart jarvis` only for deliberate manual service/config operations.


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
