# JARVIS

JARVIS is a self-hosted Telegram AI assistant for a trusted Linux machine. It gives an allowlisted Telegram user a high-agency assistant with local memory, scheduled jobs, background workers, web search, and real shell/filesystem access on the host.

If you want a private assistant you can run on your own box, start here. If you want a multi-user SaaS bot or something safe to expose to strangers, this is not that — JARVIS is intentionally powerful and should only run for users you trust.

## Install in one command

Prereqs on the target Linux host:

- `bash`, `git`, and `python3`
- Node.js 20.18.1+; pnpm is installed through Corepack if needed
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
- Markdown memory notes under `~/.jarvis/data/notes/`, plus optional adaptive voice guidance in `~/.jarvis/prompts/SOUL.md`.
- Natural-language lexical recall across notes and past user/assistant conversations, with bounded cited results and no external indexing service.
- Built-in tools: read, write, edit, bash, Exa-backed web search/fetch, configurable-confirmation browser workbench, and conversational MCP integration management.
- Telegram image/document input, optional local whisper.cpp voice/audio transcription, and conversational delivery of generated files back to the active chat.
- Automatic reply, quote, and forwarded-message context with strict untrusted-content boundaries and threaded first responses.
- Local-only Playwright browser workbench for page inspection plus guarded benign interaction, with persistent profile, screenshots, and JSON artifacts.
- Conversational reminders and recurring automations with strict timezone-aware parsing, durable cancellation/history, and cron support through a validated scheduler control tool.
- Detached background workers using isolated git worktrees and role pipelines.
- PR-only `main` workflow with a required SemVer version gate, then guarded deploy of the merged commit without direct pushes to `main`.
- Safe remote-update helper that builds before restart and preserves host-local data.
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
- `background` — worker concurrency and optional per-role model routing; roles otherwise inherit the active model.
- `telegram` — typing indicator and parse mode.
- `stt` — optional local whisper.cpp speech-to-text for Telegram voice/audio.
- `scheduler` — enablement, timezone, notification chat, bootstrap tasks.
- `logging` — audit log behavior, redaction, truncation, log level.

Configuration is primarily managed conversationally: ask JARVIS to inspect or change a setting. It uses the validated `config_control` capability to plan an atomic change, preserve rollback history, and explain whether a guarded restart is required. Secrets in `.env` are deliberately excluded. Manual edits remain supported. `schema_version` is migrated from the original unversioned format, future versions fail closed, and deployments validate the actual live config before activation.

Owner secrets can be entered without passing a value through Telegram using the opt-in one-time browser flow; see [owner secret drop](docs/secret-drop.md).

MCP integrations are also managed conversationally and are re-read without a restart. See [Conversational MCP integrations](docs/mcp-integrations.md) for the credential-reference and authority model.

## Telegram commands

```text
/new                  force-rotate the current chat session
/cancel               abort the currently running agent turn for this chat
/thinking [on|off]    show coarse progress updates for future turns
/verbose [on|off]     show more detailed progress/tool updates for future turns
/usage                show local context and token/cost usage estimates
/version              show the running JARVIS version
/secretdrop KERNEL_API_KEY [5-10]  create one-time secret submission link

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

## Outbound artifacts

During an interactive Telegram turn, JARVIS can use its run-scoped `send_artifact` capability to return generated reports, patches, archives, and browser screenshots directly to the current chat. The capability accepts only a local path and optional caption—it cannot select another chat or fetch a URL. Generated deliverables should normally be written under `~/.jarvis/data/outbound/` first.

Delivery is restricted to bounded regular files in approved repository, outbound, workbench, inbound-document, or temporary roots. Symlinks, devices, directories, oversized files, credentials, configuration, transcripts, notification state, dependency trees, and other protected state are rejected. Scheduled jobs and background workers do not receive this tool. Each upload crosses the durable chat replay boundary before any bytes are sent, so a later model or persistence failure cannot automatically repeat the delivery.

## Browser workbench

The browser workbench defaults to local Chromium. It opens public `http(s)` pages in a persistent profile, captures title/visible text, and writes screenshots/JSON artifacts under `~/.jarvis/data/workbench/`. An optional Kernel.sh hosted-browser backend is configured only with an env-var reference and falls back to local Chromium if session acquisition fails before a plan starts. Every navigation, redirect, and subresource is DNS-checked against private/reserved ranges. Benign reading, clicking, and non-secret text entry are automatic. Normal privileged actions follow `tools.owner_approval.required` (this host defaults to `false`; set it to `true` to restore short-lived, exact-plan Telegram confirmations). Resolved DOM semantics are checked before activation, while credentials/login/2FA/CAPTCHA and purchases/payments remain hard-blocked regardless of that setting. Kernel hosted auth only returns a user-completed hosted URL; JARVIS neither enters nor persists credentials. See [browser workbench docs](docs/workbench.md) for exact setup.

Smoke test:

```bash
pnpm exec playwright install chromium   # if the browser binary is not installed yet
pnpm run workbench:smoke                # deterministic local fixture: benign click + fill
pnpm run workbench:smoke -- https://example.com
```

See `docs/workbench.md` for capability binding, replay protection, network isolation, data paths, and current limitations. CAPTCHA bypass, login/2FA automation, purchases, downloads, Docker Compose packaging, and noVNC/KasmVNC human takeover are not implemented.

## Conversation recall

Ask JARVIS naturally about an earlier discussion, decision, or saved fact. The audited `search_memory` capability incrementally reconciles host-local Markdown notes and active/archived session text, then returns bounded snippets with source/date citations. Tool calls and tool results are excluded. See [`docs/memory-search.md`](docs/memory-search.md) for indexing, ownership, deletion, and privacy behavior.

## Telegram documents

Send JARVIS a UTF-8 text/source/config/CSV/JSON/XML/YAML file or a text-layer PDF, optionally with a caption describing what to do. Accepted originals are stored privately under host-local data and extracted content is clearly marked as untrusted reference material. See [`docs/document-ingestion.md`](docs/document-ingestion.md) for supported formats, limits, and safety boundaries.

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

`/goal` is a bounded controller over background workers, not a permission bypass or infinite agent loop. `/goal start [--max-tasks N] [--max-minutes N] [--max-failures N] [--auto] <objective>` creates persistent state under `~/.jarvis/data/goals/` and launches one child background task at a time. Defaults are intentionally conservative: one task, two hours, zero failures, and no auto-continue. A goal stops or waits when task/time/failure budget is exhausted, a child task needs fixes or main approval, or the owner pauses/stops it. Goal children can prepare reviewed changes in their worktrees, but they can never push, merge, deploy, restart services, or edit the main checkout. Main JARVIS may run the PR lifecycle after review: push a branch, open/watch a PR, fix its version gate, and auto-merge only once required checks are green; it then deploys merged `main`. Destructive operations still require explicit owner approval. All goal transitions append JSONL events for auditability.

## Development

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run coverage
```

The test command creates an isolated temporary JARVIS data directory and placeholder credentials automatically; it does not depend on `~/.jarvis`.

`pnpm run check` runs format check, lint, typecheck, and coverage.

Main JARVIS publishes changes through pull requests only: after review it may push a feature branch and open the PR, then starts a durable read-only CI watch using the PR number and exact pushed head SHA. The watcher survives restarts, reconciles new heads, and sends one internal result event; it cannot push, merge, or deploy. Main JARVIS may fix a failing version gate and enable auto-merge once required checks are green. After the PR is merged and local `main` matches `origin/main`, `pnpm deploy:self` verifies or reuses that exact-SHA artifact and atomically activates it; it never pushes `main`. Background workers cannot invoke this publishing or deploy path.

CI runs on pushes to `main` and pull requests targeting `main` using Node 20 and 22. Every merged/deployed change must increment `package.json`: every pull request targeting `main` must set it to a valid SemVer version strictly greater than the PR's base `main` version. The required `Version gate` CI check reports both versions when it fails. Use the release workflow (`pnpm run release`) to prepare the version and changelog together.

Versioning follows semver: patch for fixes, minor for additive features, major for breaking data/config changes.

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
