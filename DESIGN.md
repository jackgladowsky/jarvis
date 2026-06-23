# JARVIS — Design Doc

**Status:** living design notes; implementation exists
**Owner:** Project owner / host operator
**Last updated:** 2026-05-25

A personal, persistent AI assistant. Lives on the owner's trusted Linux host, accessed primarily via Telegram, built on `pi-agent-core`. Authenticates to Codex (Codex OAuth-capable account) via OAuth.

This doc captures the original design rationale plus selected architecture notes. Some later sections remain historical; prefer `README.md`, `AGENTS.md.example`, `config.yaml.example`, and source for current operational detail.

> **A note on length:** this doc is long because every section reflects a real decision. Keep factual drift corrected, but avoid turning it into a second README. The live system prompt is `~/.jarvis/prompts/system.md`; the repo template is `prompts/system.md.example`; detailed procedures live in `SKILLS.md` and `skills/*/SKILL.md`.

---

## 1. Goals & Non-Goals

### Goals

- A genuinely useful daily-driver assistant, not a toy.
- Persistent across conversations — remembers context, projects, decisions.
- Reachable from anywhere via Telegram (no laptop required).
- Can do real work: shell, files, web. Lives on a real machine and isn't fenced off from it.
- Single-user (single owner only) for v1. Hard-allowlisted by Telegram user ID.
- Minimal tool surface, maximum capability — borrow `pi-coding-agent`'s "four tools is enough" philosophy.
- Clean updates: pulling new code never risks accumulated data.
- Clean configuration: everything tunable lives in one place, edited directly.
- **Memory through filesystem convention, not through code.** The system prompt points to concise procedural skills; notes are markdown files JARVIS reads on demand.

### Non-Goals (for v1)

- Multi-user / shared access.
- Voice interface.
- Local LLM inference.
- Calendar / email style integrations. Scheduled prompts exist, but external app integrations do not.
- Episodic memory / semantic search over past sessions. (v2.)
- Web UI. Telegram is the only interface.
- SSH-out to other machines. Parked — interesting future direction, but not v1.
- Custom note/memory tools. Notes are just files in a known directory.
- Hot-reload of config. Restart the service.
- **Confirmation flows for destructive operations.** JARVIS lives on a non-critical box and is allowed to do what it wants. The audit log is the safeguard, not prevention.
- **Dynamic memory injection at session start.** The system prompt is a static reference document; JARVIS reads notes on demand.

---

## 2. Hardware & Hosting

**Host:** the owner's trusted Linux host.

- Any always-on Linux host with enough headroom for Node, local tools, and optional speech-to-text.
- May run other trusted personal services; keep independent backups for anything important.
- JARVIS runs as a regular Linux user with full shell access to its own machine. The systemd installer uses the installing user (`User=$(whoami)`); on the original host that was the owner's normal Unix user, not a separate `jarvis` user.

**Threat model posture:** the box is non-critical and JARVIS is an _inhabitant_ of it, not a fenced-off operator. If JARVIS does something dumb, worst case is reinstalling the OS and redeploying from git. The important local data has independent backups, so even that worst case is recoverable.

**Filesystem layout (high level):**

- **`~/jarvis/`** — source code, git-managed. Replaceable wholesale.
- **`~/.jarvis/`** — config, data, logs. Never in source. Survives updates.

This separation is load-bearing — see §8 for the rationale and §14 for the resulting update flow.

**Networking:**

- No inbound ports needed — Telegram bot polls Telegram's servers (outbound).
- Tailscale optional, useful for SSH-in from anywhere.

### Why this and not a Pi / container / VM

Considered and rejected:

- **Dedicated Pi 5:** physically separate, but the whole point of giving JARVIS a real environment is so it can do useful work. A Pi as a fenced-off box just makes everything harder.
- **Docker container on trusted Linux host:** isolation is mostly cosplay (you'd end up mounting the Docker socket or bind-mounting `/`), and the agent fights its own constraints constantly.
- **Proxmox + LXC:** real isolation, but the trusted Linux host isn't running Proxmox and reinstalling for this isn't worth it.

The deciding factor: the owner accepts the risk of running an agent on a non-critical host. Isolation that solves a problem you don't have is just complexity.

---

## 3. Stack

- **Language:** TypeScript (Node 20+).
- **Agent framework:** `@mariozechner/pi-agent-core` for the loop. Mirror tool implementations and core agent logic (compaction, etc.) from `@mariozechner/pi-coding-agent` but don't extend it directly — its CLI/TUI/per-cwd-session model fights the Telegram use case. **Default rule:** when designing agent logic, look at how pi does it before inventing custom machinery.
- **LLM provider:** Codex via OAuth (Codex OAuth-capable account), through `pi-ai`'s OAuth flow. Anthropic API key as a fallback.
- **Transport:** Telegram Bot API. Library: `grammy`.
- **Config:** YAML for tunables, dotenv for secrets. `zod` for runtime validation.
- **Storage:** Plain files for v1. JSONL for sessions/jobs/workers, markdown for notes, append-only flat file for audit log. SQLite is on the table later if files become limiting.

---

## 4. Persona & System Prompt

JARVIS is competent, calm, concise, and dry. Familiar with the owner, not formal. No "sir." No theatrical butler voice. The Iron Man name is a wink, not a costume.

### Voice

- **Concise by default.** Short answers to short questions. Length scales with the question.
- **Direct.** No filler, no "great question," no "I'd be happy to help."
- **Honest.** Pushes back when the owner is wrong, unclear, or about to do something dumb. Says "I don't know" when it doesn't.
- **Dry humor when warranted.** Never forced.
- **Familiar.** Uses the owner's name occasionally, never "sir" or "boss."

### Examples

> **Owner:** what's the weather
> **JARVIS:** 52 and overcast, rain after 4pm. Bring a jacket if you're heading out.

> **Owner:** can you restart the local service server
> **JARVIS:** Done. Back up, took 1.2s. Logs look clean.

> **Owner:** i think i should rewrite the whole memory layer
> **JARVIS:** What's wrong with the current one? You wrote it three days ago.

### Anti-examples

- "Right away, sir."
- "I'd be happy to help with that!"
- "Great question!"
- "Allow me to..."
- "Of course! Here's what I'll do: [bulleted plan of obvious steps]"
- Apologizing for things that aren't problems.

### The system prompt is a standalone document

The system prompt lives in its own file at `~/.jarvis/prompts/system.md`. It is loaded verbatim at session start — **no dynamic injection, no content from notes pre-loaded into it**.

The prompt's job is to be the small core operating manual: persona, tools, host/source/data anchors, safety rules, and the instruction to read repo-local skills on demand. Detailed procedures live in `SKILLS.md` and `skills/*/SKILL.md`, which JARVIS reads with the normal file tools only when relevant.

This means:

- The prompt is a single artifact you edit. What you see in the file is exactly what JARVIS gets.
- Token budget at session start is fixed and predictable. Memory and procedure docs do not bloat the prompt.
- Behavior is specified by plain files read on demand. No "the prompt says X but the injection logic does Y."

The canonical prompt lives in `~/.jarvis/prompts/system.md`; the repo template is `prompts/system.md.example`; repo skills live in `SKILLS.md` and `skills/*/SKILL.md`. JARVIS itself can edit the live prompt, though changes only take effect after a service restart.

---

## 5. Tool Surface (v1)

Five tools. Adding another tool is still something to _resist_, not something to do speculatively — the model is smart and can compose. The first four mirror `pi-coding-agent`; the fifth (`web_search`) is the deliberate exception, see below.

```
read(path)               # read a file
write(path, content)     # create or overwrite
edit(path, old, new)     # surgical string-replace, must be unique
bash(command, timeout?)  # run shell commands, captures stdout/stderr/exit
web_search(input)        # query → /search; URL → /contents (Exa-backed)
```

For most things, `bash` is still the universal tool. Want to manage Docker? `bash docker ps`. Restart a service? `bash systemctl restart foo`. Search the filesystem? `bash grep -r ...`. Curl an internal API? `bash curl ...`.

### Why we have web_search (the one exception to "four tools")

The original plan was `bash curl` + `bash w3m -dump` for v1. In practice that fails on two fronts: there's no curl-able general-purpose search engine, and most public sites now block `curl` user-agents outright (Cloudflare, anti-scraping). So we added one tool, backed by Exa (the configured Exa API key):

- **One tool, two modes.** Pass a query → `POST /search`; pass an http(s) URL → `POST /contents`. Dispatch is on input shape — no `mode` parameter, no separate `web_fetch` companion.
- **Search returns metadata only** (title + URL + date). No `contents` requested. The model picks a result and follows up with a URL fetch when it actually wants the page. This keeps token cost predictable.
- **Contents returns extracted markdown**, capped at 25k chars to bound context.
- **Internal/private URLs still go through `bash curl`** — Exa only knows the public web.

If the cap or defaults turn out wrong in practice, tune them in `web-search.ts`. There's intentionally no config block for them — yet another knob is overkill for this surface.

### Why no note tools

Notes are markdown files in `~/.jarvis/data/notes/`. JARVIS reads them with `read`, edits them with `edit` or `write`. The filesystem is the API. Custom note tools would be reinventing files with worse ergonomics — the model already knows how to work with files, so we use that.

### Tool safety posture

- The trusted Linux host is the sandbox. JARVIS can do anything inside it.
- **No confirmation flow.** JARVIS executes what it decides to execute. If it does something destructive, that's accepted risk.
- **Audit log is the actual safeguard.** Every tool call hits `~/.jarvis/data/audit.log` with timestamp, redacted args, outcome. Append-only. See §14 for redaction/rotation.
- The important local data backups are independent of JARVIS.

---

## 6. Skills Convention

A repo-local `SKILLS.md` index and `skills/<slug>/SKILL.md` files hold procedural instructions that used to make the system prompt bulky. The prompt tells JARVIS to read relevant skills on demand, not to load them all at session start.

Initial skills:

- `background-workers`
- `deploy`
- `scheduler`
- `memory`
- `destinations`
- `github-pr`
- `host-ops`
- `web-search`
- `deep-research`

Skills are source-controlled because they describe behavior and procedures, not host-local facts. Host-specific facts remain in `~/.jarvis/AGENTS.md`; accumulated memory remains in `~/.jarvis/data/notes/`. If a skill conflicts with `AGENTS.md` for host facts, `AGENTS.md` wins.

## 7. AGENTS.md Convention

Borrowed from `pi-coding-agent`. A hand-written markdown file at `~/.jarvis/AGENTS.md` documents the environment. The system prompt and skills are intentionally generic and do not name the host, user, or running services — JARVIS reads `AGENTS.md` on demand for that. This keeps the system prompt portable and makes per-host facts editable without a code/prompt change.

This is _not_ memory — it's environment documentation, curated by the owner (or by JARVIS at the owner's instruction). Stable. Memory in the accumulating sense lives in `~/.jarvis/data/notes/` (see §12).

A _template_ `AGENTS.md.example` lives in the repo with placeholders. On first install, the setup script copies it to `~/.jarvis/AGENTS.md`; from then on, the live copy is edited freely and updates never overwrite it.

Sketch contents (see `AGENTS.md.example` for the full template):

```markdown
# AGENTS.md — JARVIS environment

## Host

- Hostname: <hostname>
- Hardware: <make/model>
- OS: <distro + version + kernel>

## User JARVIS runs as

- <username> (uid <N>)
- Sudo: <passwordless? gated?>
- Home: /home/<username>

## JARVIS layout

- Source: ~/jarvis/
- Data: ~/.jarvis/
- Audit log: ~/.jarvis/data/audit.log

## Services running on this box

- <docker containers, systemd services, etc.>

## Conventions

- <where projects live, etc.>
```

---

## 8. Source / Data Separation

The single most important structural decision in this design. Source code and data have totally different lifecycles, and the layout reflects that.

### Source: `~/jarvis/`

- Git-managed.
- Contains: TypeScript source, package.json, tsconfig, build scripts, templates (`AGENTS.md.example`, `config.yaml.example`, `prompts/system.md.example`), skills, README.
- Replaceable wholesale: deleting and re-cloning loses nothing.
- Updated via `scripts/safe-deploy.sh` on installed hosts, or `pnpm install && pnpm run build` for local development.

### Data: `~/.jarvis/`

- Never in source, gitignored if the path ever appears in source for any reason.
- Contains: secrets (`.env`), config (`config.yaml`), prompt (`prompts/system.md`), environment docs (`AGENTS.md`), sessions, notes, audit log, regenerable cache.
- Survives updates by virtue of being in a different directory.
- Irreplaceable; back it up separately from source. `scripts/backup-jarvis-data.sh` creates local tarball backups, while off-box policy remains operational.

### Why this matters

With this split, updates are atomic and risk-free. Without it, every update has to be careful about what to preserve. The cost of separation is one extra path to track in code; the benefit is that the update story becomes a non-issue.

### Path resolution

A small `paths.ts` module in source resolves paths relative to either tree. All data access in the codebase goes through it. Default base path for data is `~/.jarvis/`, overridable via `JARVIS_DATA_DIR` env var (useful for testing).

```typescript
// src/paths.ts (sketch)
import { homedir } from "os";
import { join } from "path";

const DATA_BASE = process.env.JARVIS_DATA_DIR ?? join(homedir(), ".jarvis");

export const paths = {
  data: DATA_BASE,
  env: join(DATA_BASE, ".env"),
  configYaml: join(DATA_BASE, "config.yaml"),
  agentsMd: join(DATA_BASE, "AGENTS.md"),
  systemPrompt: join(DATA_BASE, "prompts", "system.md"),
  sessions: join(DATA_BASE, "data", "sessions"),
  sessionsArchive: join(DATA_BASE, "data", "sessions", "archive"),
  activeSessions: join(DATA_BASE, "data", "sessions", "active.json"),
  notes: join(DATA_BASE, "data", "notes"),
  notesProjects: join(DATA_BASE, "data", "notes", "projects"),
  notesProjectsArchive: join(DATA_BASE, "data", "notes", "projects", "archive"),
  audit: join(DATA_BASE, "data", "audit.log"),
  cache: join(DATA_BASE, "cache"),
};
```

### Schema versioning (forward-compatibility for v1)

Data formats (especially session JSONL) are designed to be additive only — new fields are optional, old fields are never removed. Avoids needing a migration system in v1. If a breaking change is ever required, write a one-shot migration script.

A `~/.jarvis/data/.schema-version` file is reserved for v2 if/when explicit migrations become necessary.

---

## 9. Configuration

Two files, two purposes:

- **`~/.jarvis/.env`** — secrets only. Loaded by systemd via `EnvironmentFile=`, available as `process.env.*`. Restricted permissions (`chmod 600`). Never committed, never logged.
- **`~/.jarvis/config.yaml`** — everything else. Tunables, behavior toggles, feature flags. Human-edited freely. Comments encouraged.

The system prompt is its own separate file (`~/.jarvis/prompts/system.md`) referenced by neither — it's loaded directly by code at a known path.

### `.env` contents

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123456789           # comma-separated if multiple
# CODEX_OAUTH_CREDS_PATH=                     # optional override; defaults to <data_dir>/.codex-creds.json
ANTHROPIC_API_KEY=...                         # optional, fallback provider
```

The Codex creds path defaults to `~/.jarvis/.codex-creds.json` (resolved via `paths.data` in `src/agent/auth.ts`). Set the env var only when you need to point at a creds file outside the data dir.

### `config.yaml` contents

See `config.yaml.example` for the current committed schema and defaults. Keep that file as the source of truth for concrete model names, Telegram parse mode, scheduler settings, and any newly added config keys; embedded examples in this design doc are intentionally avoided to prevent drift.

Note what's _not_ here anymore:

- `memory.inject_files`, `memory.max_notes_injected_chars` — gone, no injection.
- `tools.confirm_before_running` — gone, no confirmation.
- `persona.*` — gone, system prompt is a standalone file.

### Loading and validation

One module loads config and exports a frozen, validated object. Invalid config fails startup with a clear error.

```typescript
// src/config.ts (sketch)
import { z } from "zod";
// ... ConfigSchema mirrors the YAML structure
const raw = parseYaml(readFileSync(paths.configYaml, "utf-8"));
export const config = Object.freeze(ConfigSchema.parse(raw));
```

### Principles

- **No defaults in code.** Every tunable must be present in `config.yaml`. The example file is committed in source as documentation.
- **Fail fast.** Invalid config blocks startup.
- **Frozen at startup.** Restart to apply changes.
- **One source of truth.** If a value lives in `config.yaml`, it does _not_ also live as a constant in code.

---

## 10. Filesystem Layout (full)

### Source tree (`~/jarvis/`, git-managed)

```text
~/jarvis/
├── src/
│   ├── index.ts                        # entrypoint and startup orchestration
│   ├── config.ts                       # YAML + env loading, validation, frozen export
│   ├── paths.ts                        # central data-path resolution
│   ├── scheduler.ts                    # recurring and one-time scheduled jobs
│   ├── transport/telegram.ts           # bot, commands, streaming, image input
│   ├── background/                     # task manager, worker, pipeline types
│   ├── agent/                          # runtime, auth, sessions, compaction, summarizer, tools
│   └── lib/                            # logging, formatting, allowlist, mutex, deploy notice
├── scripts/
│   ├── setup-host.sh                   # bootstrap ~/.jarvis, install deps, build
│   ├── install-systemd.sh              # install jarvis.service and logrotate
│   ├── safe-deploy.sh                  # fast-forward/build/delayed restart with notices
│   ├── update.sh                       # compatibility alias for safe-deploy.sh
│   ├── start-background-task.sh        # shell entrypoint for detached workers
│   ├── run-background-worker.sh        # worker bootstrap wrapper
│   └── backup-jarvis-data.sh           # data backup helper
├── AGENTS.md.example                   # host facts template
├── SKILLS.md                           # skill index / convention
├── skills/                             # procedural skills read on demand
├── config.yaml.example                 # non-secret config template
├── prompts/system.md.example           # concise system prompt template
├── .env.example                        # secrets template
├── package.json
├── tsconfig.json
├── DESIGN.md
└── README.md
```

### Data tree (`~/.jarvis/`, never in source)

```text
~/.jarvis/
├── .env                                # secrets (chmod 600)
├── .codex-creds.json                   # default Codex OAuth credentials path
├── config.yaml                         # tunables
├── AGENTS.md                           # environment docs (live)
├── prompts/system.md                   # system prompt (live, edited freely)
├── data/
│   ├── sessions/                       # Telegram chat sessions
│   ├── notes/                          # markdown memory
│   ├── jobs/                           # scheduler tasks, sessions, notes, log
│   ├── background/                     # worker task JSON, sessions, notes, mail, logs
│   ├── deploy/                         # safe-deploy pending/completed markers
│   └── audit.log                       # every tool call, append-only, redacted+truncated
└── cache/                              # safe to delete, regenerable
```

---

## 11. Session Model (Model C — Time-Windowed)

### Lifecycle

1. Telegram message arrives.
2. **Acquire per-`chat_id` mutex** — only one agent loop per chat at a time. Subsequent messages queue.
3. Look up the active session for this `chat_id`.
4. If no active session exists, OR last message > `session.inactivity_threshold_minutes` ago, OR the session has been alive > `session.max_duration_hours`:
   a. If a previous session exists, queue it for summarization and archive.
   b. Create a fresh session, generate session_id.
   c. Load `~/.jarvis/prompts/system.md` verbatim as the system message. **No notes injected.**
5. Append the user message; run the agent loop; append the assistant response and any tool calls/results.
6. Persist the session to disk after every turn.
7. Release mutex.

All thresholds come from `config.yaml`. Each `.jsonl` file: one message per line.

### Per-chat serialization

The mutex prevents concurrent agent loops on the same chat, which would otherwise corrupt the session JSONL and produce interleaved tool calls. v1: simple async queue keyed by `chat_id`. If the owner sends a message while one is in-flight, it queues behind.

A `/cancel` command bypasses the per-chat queue and aborts the currently-running agent loop for that chat.

### Compaction (within a session)

Mirror `pi-coding-agent`'s algorithm directly — same shape, same defaults. Canonical reference: [pi-mono compaction docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md). Summarized:

- **Trigger:** `context_tokens > context_window - reserve_tokens`. One threshold, no soft/hard split.
- **Algorithm:** walk backward from the newest message accumulating tokens until `keep_recent_tokens` is reached → that's the cut. LLM-summarize everything from the previous compaction boundary (or session start) up to the cut, using a structured prompt (Goal / Constraints / Progress / Decisions / Next / Critical Context). Reload context as `[system prompt] + [summary] + [messages from firstKeptEntryId onward]`.
- **Iterative:** subsequent compactions pass the previous summary in as context, so history isn't lost across multiple passes.
- **Persisted in the JSONL.** The summary is written as a `compaction` entry — `{type, id, timestamp, summary, firstKeptEntryId, tokensBefore}` — sitting inline with regular messages. The JSONL stays self-contained: no sidecar files. Crash recovery (open question #7) replays the JSONL and the compaction entries do their job naturally.
- **Manual override:** not exposed as a Telegram command; compaction is automatic.
- **Sticky:** only the system prompt. Everything else (including notes JARVIS read this session) is compactable — it can re-read.

Defaults live in `config.yaml.compaction`: `enabled: true`, `reserve_tokens: 16384`, `keep_recent_tokens: 20000`. Match pi's defaults; tune based on actual usage.

### Session-end TOC update (between sessions)

When a session rotates and `session.summarize_on_rotation` is true, run one LLM call: produce a one-line entry summarizing the session, append it to `recent.md`. That's the entire job.

- **Single file, append-only.** No multi-file routing, no structured-op schema, no path-allowlist validation, no idempotence dance.
- **JARVIS writes everything else inline.** Decisions, durable facts, project status, todos, environment discoveries — these go into their respective notes files _during the conversation_, via `read`/`write`/`edit`, governed by the write triggers in the system prompt. The model is in the conversation when the durable fact is observed; that's the right moment to capture it. Reconstructing intent from a transcript after the fact is harder and more error-prone.
- **Why split it this way:** `recent.md` is the one thing that genuinely has to be code-driven — a session can't write its own TOC entry from inside itself. Everything else can be done by JARVIS in context, with full nuance, while it still has the thread.
- **Cost:** if JARVIS forgets to write a decision to `decisions.md` mid-conversation, it's lost from notes (still in the JSONL). Mitigation: the system prompt has explicit write triggers; Phase 7 tunes them based on what actually gets missed.

`recent.md` cap: 30 entries. Older entries archived to `archive/recent-YYYY-MM.md` automatically. The session manager is the only code-side writer to `recent.md`; JARVIS never writes to it — rule enforced in the prompt.

### Behavioral details

- **Silent rotation.** No "good morning, picking up from yesterday." JARVIS reads notes on demand based on conversation cues. Toggleable via `session.announce_new_session`.
- **Manual reset.** Reserved command `/new` force-rotates the current session.
- **Storage hygiene.** Session archive is never auto-deleted. Disk is cheap.

---

## 12. Memory Architecture

Memory in JARVIS is _filesystem convention + prompt rules + on-demand retrieval_. There is no dynamic injection, no memory subsystem in code beyond the summarizer.

### How it works

1. The system prompt describes the structure of `~/.jarvis/data/notes/` — what files exist, what each is for, when to read, when to write, in what format.
2. JARVIS reads notes via the `read` tool when conversation cues match the prompt's read triggers.
3. JARVIS writes notes via `write`/`edit` when it observes something worth remembering, per the prompt's write triggers.
4. On session rotation, the session-end summarizer appends one TOC entry to `recent.md` and nothing else. It is the only code-side writer to `recent.md`. All other notes are written by JARVIS itself, in-conversation, via its tools.

### The notes structure

```
~/.jarvis/data/notes/
├── about.md          — stable identity facts about the owner (~1KB cap)
├── environment.md    — runtime-discovered facts about the system
├── recent.md         — rolling TOC of past sessions (30 entries max)
├── decisions.md      — decisions log, append-only
├── todo.md           — open questions / follow-ups (items removed when resolved)
├── preferences.md    — how the owner likes things done
└── projects/
    ├── <slug>.md     — one file per active project
    └── archive/
        └── <slug>.md — archived projects (no recent activity OR explicitly done)
```

Each file has a defined purpose, defined read trigger, defined write trigger, defined format. All of this lives in the current system prompt template.

### Why this works

- **Bounded context cost.** The system prompt is fixed-size, no matter how much memory accumulates.
- **Relevance via retrieval.** JARVIS reads only what the conversation needs.
- **Inspectable and editable.** All memory is markdown. `cat ~/.jarvis/data/notes/projects/hockey-cv.md` and read what JARVIS knows.
- **Self-organizing.** JARVIS extends and updates notes during conversations; the session-end summarizer keeps `recent.md` current as a TOC.
- **Files have purpose, not just chronology.** Easier to navigate than one big chronological log.

### The cost

First-read latency. When the owner mentions a project, JARVIS does an extra `read` before responding. Acceptable — most messages don't need memory at all, and `read` is cheap.

The risk is JARVIS _not_ reading when it should. Mitigation: the prompt is explicit about read triggers, and the first weeks of usage will surface where the rules need to be tightened.

### Episodic memory (v2 — not built)

Searchable history of past sessions. "What did we decide about X two weeks ago?" Out of scope for v1. The JSONL archive plus monthly archives of `recent.md` and projects make this addable later (grep first; vector embeddings if grep isn't enough).

---

## 13. Telegram Transport

- **Library:** `grammy`.
- **Auth:** Hard allowlist of Telegram user IDs from `TELEGRAM_ALLOWED_USER_IDS` in `.env`. Messages from non-allowlisted users are silently dropped + logged.
- **Typing indicator:** while the agent is processing, fire `chat_action: typing` every 4 seconds (Telegram expires the indicator after ~5s, so we re-fire on a timer). Stops the moment the run resolves.
- **Token streaming for the final response:** subscribe to pi-agent-core events. For each assistant message, examine its content blocks: if any `toolCall` block appears, the message is part of internal reasoning and is **not** shown to the user. Only assistant messages that are pure text (no tool calls) are streamed to Telegram via a placeholder + debounced edits (~1.5s minimum between edits to stay under Telegram's edit rate limit). Net effect: the user sees typing → final answer streaming in. Tool calls and "let me check…" filler messages are invisible.
- **Markdown:** Default `parse_mode: HTML`. Responses run through a small markdown→HTML converter (`src/lib/format.ts`) that handles fenced code blocks, inline `code`, `**bold**`, and `*italic*`; everything else is HTML-escaped for safety. MarkdownV2 was rejected as a footgun (one unescaped `.` blows up the whole send). Setting `parse_mode: none` in config falls back to raw text without conversion.
- **Per-chat serialization:** see §11.
- **Image input:** Telegram photos and image documents are downloaded, capped at 4 images and 10 MB each, and passed to the model alongside the message text/caption.
- **Progress commands:** `/thinking` and `/verbose` toggle coarse/verbose progress messages for future turns.
- **Background commands:** `/bg`, `/tasks`, `/task`, `/answer`, and `/cancelbg` manage detached worker tasks.
- **Bot token security:** Token in `~/.jarvis/.env`, never committed. The user-ID allowlist is the real defense.

---

## 14. Deployment & Updates

### Initial install (one-time)

```bash
# As the target service user on the host:
git clone <repo> ~/jarvis
cd ~/jarvis
./scripts/setup-host.sh
# Edit ~/.jarvis/.env with secrets
# Edit ~/.jarvis/config.yaml with tunables (or leave defaults)
# Edit ~/.jarvis/AGENTS.md with environment details
# Optionally edit ~/.jarvis/prompts/system.md
./scripts/install-systemd.sh
```

`setup-host.sh` creates `~/.jarvis/`, copies templates with "only if not exists" semantics, runs `pnpm install && pnpm run build`. Re-running setup never overwrites live configs.

### Updates

```bash
cd ~/jarvis
scripts/safe-deploy.sh
```

`safe-deploy.sh` is the normal installed-host update path. It refuses dirty working trees, fast-forwards, installs dependencies, builds, sends a Telegram restart notice, writes a pending marker, and schedules a short delayed systemd restart so the launching chat response can complete. On startup, JARVIS consumes the marker and sends a back-online notice. `scripts/update.sh` is a compatibility alias. Nothing in `~/.jarvis/` is touched. Raw `sudo systemctl restart jarvis` is reserved for deliberate manual service/config operations.

### Config / template drift on updates

If a new version adds a config key, `config.yaml.example` will have it but the live `~/.jarvis/config.yaml` won't. Strategy:

- v1: missing required keys cause startup to fail with a clear error. the owner diffs and adds.
- No auto-merge: diff the example against the live file and add required keys manually. Missing required keys fail fast at startup with a Zod error.

Same for `AGENTS.md.example` and `prompts/system.md.example` — drift expected, no auto-merge.

### Service config

`scripts/install-systemd.sh` writes `/etc/systemd/system/jarvis.service` and `/etc/logrotate.d/jarvis` from values probed at install time — the running user, the absolute repo path, the `node` binary on `PATH`, and `JARVIS_DATA_DIR` (or `~/.jarvis/`). Re-running it overwrites the unit with a fresh render of those values.

- Runs as the user who installed it (`User=$(whoami)`); not auto-started.
- `Type=simple`, `Restart=on-failure`, `RestartSec=5`.
- `WorkingDirectory=<absolute repo path>`, `EnvironmentFile=<DATA_BASE>/.env`.
- `ExecStart=<absolute node path> <repo>/dist/index.js`.
- Logs go to journald — `journalctl -fu jarvis` to follow.

### Audit log hygiene

The audit log is the one safeguard now that confirmation is gone. It must be useful:

- **Truncation:** any logged value (tool input, tool output) larger than `logging.audit_log_max_value_bytes` (default 2KB) is truncated to `<first 1KB>...[truncated N bytes]...<last 1KB>`.
- **Redaction:** when `logging.audit_log_redact_patterns` is true (default), values are scanned for common secret shapes — `sk-...`, `ghp_...`, JWT-shaped strings, `[A-Z_]+=[A-Za-z0-9+/=]{20,}` — and matches are replaced with `[REDACTED]`.
- **`read`/`write` content:** logged as path + byte count, not contents. (If you need to see what was read or written, the file itself is on disk.)
- **Rotation:** logrotate config installed by `install-systemd.sh`. Daily rotation, keep 30 days, gzip.
- **What's logged:** timestamp, tool name, redacted/truncated args, exit status / outcome summary, duration.

### Backups

The irreplaceable surface is `~/.jarvis/` excluding cache: config, prompts, notes, sessions, audit log, `.env`, and OAuth credentials. Nothing under `~/jarvis/` (source) needs backup; it's git.

`scripts/backup-jarvis-data.sh` creates a local tar.gz archive, verifies it, writes a SHA256 file, maintains `latest` symlinks, and prunes older archives using `JARVIS_BACKUP_KEEP` (default 14). Destination defaults to `~/backups/jarvis`; set `JARVIS_BACKUP_DIR` to move it. Off-box backup policy remains an operational choice.

Don't `rm -rf ~/.jarvis/` casually.

### Uninstall / reinstall

- Source corrupted: `rm -rf ~/jarvis && git clone ... && cd ~/jarvis && ./scripts/setup-host.sh`, then use `scripts/safe-deploy.sh` or deliberately restart the service. Data untouched.
- Wipe memory but keep code: edit or remove individual notes files. They're just markdown.
- Wipe everything: `rm -rf ~/.jarvis/`. Re-run setup to start over.

---

## 15. Open Questions

Current open items are intentionally short; historical decisions remain in §17.

1. **Rate limit / cost ceiling.** ChatGPT Plus has rate limits, not hard cost caps. A turn-counter or token-counter alert may be useful.
2. **Memory read accuracy.** The risk of retrieval-based memory is JARVIS not reading when it should. Tune prompt triggers based on real misses.
3. **Backups.** The irreplaceable surface is `~/.jarvis/data/`, `audit.log`, and `.codex-creds.json`. `scripts/backup-jarvis-data.sh` exists, but the off-box backup policy is still an operational decision.
4. **Cancellation edge cases.** `/cancel` exists; provider/tool calls may still take time to unwind.

---

## 16. Historical Build Plan

The original phase plan has served its purpose and is no longer the source of operational truth. Current setup, development, deployment, scheduler, and background-worker behavior are documented in `README.md` and enforced by the scripts/source.

### Historical Phase 0 — Codex OAuth spike

Codex OAuth was validated for server use: credentials can live under `~/.jarvis/.codex-creds.json`, refresh on the host, and fall back to Anthropic by changing `agent.provider` plus env secrets if needed.

---

## 17. Decisions Log

- **2026-05-06** — Chose `pi-agent-core` over extending `pi-coding-agent`. The latter's CLI/TUI/per-cwd-session model doesn't fit Telegram.
- **2026-05-06** — TypeScript over Python. `pi-mono` is TS-only.
- **2026-05-06** — Model C (time-windowed sessions, 4h inactivity, silent rotation, summarize on rotation).
- **2026-05-06** — Markdown files for working memory in v1. SQLite if/when needed.
- **2026-05-06** — Reactive only in initial v1; proactive scheduling deferred at launch. Scheduler support was added later.
- **2026-05-06** — JARVIS lives on the trusted Linux host as a regular user with full shell access. Dedicated Pi 5 and Docker container both rejected. The box is non-critical and isolation that solves a non-problem is just complexity.
- **2026-05-06** — Initial tool surface locked at four: `read`, `write`, `edit`, `bash`, mirroring `pi-coding-agent`. Later amended with Exa-backed `web_search`; no note tools — the filesystem is the note API.
- **2026-05-06** — `AGENTS.md` convention adopted from `pi-coding-agent`.
- **2026-05-06** — SSH-out parked. JARVIS is an inhabitant of one box.
- **2026-05-06** — Source/data separation: `~/jarvis/` source, `~/.jarvis/` data. Path resolution centralized in `src/paths.ts`. Updates: 4 commands, zero risk to data.
- **2026-05-06** — Configuration: `.env` for secrets, `config.yaml` for tunables, `prompts/system.md` for the prompt. `zod`-validated, frozen at startup, no defaults in code.
- **2026-05-06** — **No confirmation flow for destructive operations.** JARVIS executes what it decides to execute. The audit log is the safeguard, not prevention. The trusted Linux host is non-critical and the important local data has independent backups; protecting against agent mistakes adds complexity for risk that's already accepted.
- **2026-05-06** — **System prompt is a static reference document, no dynamic injection.** Loaded verbatim at session start. Notes are read on demand by JARVIS using the `read` tool, governed by rules in the prompt itself. Token budget at session start is fixed and predictable; behavior is fully specified by one editable file.
- **2026-05-06** — **Memory schema:** six files (`about`, `environment`, `recent`, `decisions`, `todo`, `preferences`) plus `projects/<slug>.md`. Each has a defined purpose, read trigger, write trigger, and format — all specified in the system prompt. The summarizer routes session content into these files mechanically; JARVIS reads them on demand.
- **2026-05-06** — Audit log gets redaction + truncation + daily rotation. With confirmation gone, the log is the actual safeguard.
- **2026-05-06** — Telegram initially defaulted to `parse_mode: none`; current default is `HTML` with a small markdown-to-HTML formatter. MarkdownV2 escaping remains a footgun.
- **2026-05-06** — Per-chat mutex on incoming messages. Concurrent agent loops on the same chat would corrupt the session JSONL.
- **2026-05-06** — **Compaction follows `pi-coding-agent` directly.** One threshold (`reserve_tokens`), one LLM call, summary persisted as a `compaction` entry inline in the session JSONL. No tiered/soft/hard scheme. Crash recovery falls out for free.
- **2026-05-06** — **Session-end summarizer scope reduced to `recent.md` only.** Multi-file routing dropped. JARVIS writes other notes (decisions, project status, durable facts, todos) inline during conversation via its tools, governed by write triggers in the system prompt. Eliminates schema/validation/dry-run/idempotence/dedup problems wholesale.
- **2026-05-06** — **`pi-mono` is the reference for agent logic.** Where in doubt, look at how `pi-coding-agent` / `pi-agent-core` does it before designing custom machinery.

---

## Appendix A — System prompt

The canonical live prompt is `~/.jarvis/prompts/system.md`; the repo template is `prompts/system.md.example`. Older copies embedded in this design doc were removed to avoid drift.

---

## Appendix B — Note seed content

Initial note examples are historical. The live memory tree is under `~/.jarvis/data/notes/`, and the expected file purposes/formats are documented in `skills/memory/SKILL.md` plus referenced by the current system prompt template.
