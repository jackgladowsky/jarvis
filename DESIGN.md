# JARVIS — Design Doc

**Status:** v0 draft, pre-build
**Owner:** Jack
**Last updated:** 2026-05-06

A personal, persistent AI assistant. Lives on Jack's M710q, accessed primarily via Telegram, built on `pi-agent-core`. Authenticates to Codex (ChatGPT Plus/Pro) via OAuth.

This doc captures decisions made so far and flags open questions. Iterate freely — nothing here is final until code is written, and even then.

> **A note on length:** this doc is long because every section reflects a real decision. Once code exists, this will likely fork into a stable `DESIGN.md` (rationale, decisions log) and a living `ARCHITECTURE.md` (paths, layout, install). For now, one file. The full system prompt is in the appendix and is the canonical version — what's in §4 is summary.

---

## 1. Goals & Non-Goals

### Goals
- A genuinely useful daily-driver assistant, not a toy.
- Persistent across conversations — remembers context, projects, decisions.
- Reachable from anywhere via Telegram (no laptop required).
- Can do real work: shell, files, web. Lives on a real machine and isn't fenced off from it.
- Single-user (Jack only) for v1. Hard-allowlisted by Telegram user ID.
- Minimal tool surface, maximum capability — borrow `pi-coding-agent`'s "four tools is enough" philosophy.
- Clean updates: pulling new code never risks accumulated data.
- Clean configuration: everything tunable lives in one place, edited directly.
- **Memory through filesystem convention, not through code.** The system prompt is the operating manual; notes are markdown files JARVIS reads on demand.

### Non-Goals (for v1)
- Multi-user / shared access.
- Voice interface.
- Local LLM inference.
- Proactive messaging on a schedule. (v2.)
- Episodic memory / semantic search over past sessions. (v2.)
- Web UI. Telegram is the only interface.
- Calendar / email integrations. (Add when wanted, not preemptively.)
- SSH-out to other machines. Parked — interesting future direction, but not v1.
- Custom note/memory tools. Notes are just files in a known directory.
- Hot-reload of config. Restart the service.
- **Confirmation flows for destructive operations.** JARVIS lives on a non-critical box and is allowed to do what it wants. The audit log is the safeguard, not prevention.
- **Dynamic memory injection at session start.** The system prompt is a static reference document; JARVIS reads notes on demand.

---

## 2. Hardware & Hosting

**Host:** Jack's Lenovo ThinkCentre M710q.
- i7-6700T, 32GB RAM, 256GB NVMe.
- Currently runs a Minecraft server and miscellaneous dev work. Nothing critical.
- JARVIS lives here as a regular Linux user (`jarvis`) with full shell access to its own machine.

**Threat model posture:** the box is non-critical and JARVIS is an *inhabitant* of it, not a fenced-off operator. If JARVIS does something dumb, worst case is reinstalling the OS and redeploying from git. The Minecraft world gets backed up nightly to a separate location so even that worst case is recoverable.

**Filesystem layout (high level):**
- **`~/jarvis/`** — source code, git-managed. Replaceable wholesale.
- **`~/.jarvis/`** — config, data, logs. Never in source. Survives updates.

This separation is load-bearing — see §7 for the rationale and §13 for the resulting update flow.

**Networking:**
- No inbound ports needed — Telegram bot polls Telegram's servers (outbound).
- Tailscale optional, useful for SSH-in from anywhere.

### Why this and not a Pi / container / VM
Considered and rejected:
- **Dedicated Pi 5:** physically separate, but the whole point of giving JARVIS a real environment is so it can do useful work. A Pi as a fenced-off box just makes everything harder.
- **Docker container on M710q:** isolation is mostly cosplay (you'd end up mounting the Docker socket or bind-mounting `/`), and the agent fights its own constraints constantly.
- **Proxmox + LXC:** real isolation, but the M710q isn't running Proxmox and reinstalling for this isn't worth it.

The deciding factor: Jack already doesn't care if the M710q gets wrecked. Isolation that solves a problem you don't have is just complexity.

---

## 3. Stack

- **Language:** TypeScript (Node 20+).
- **Agent framework:** `@mariozechner/pi-agent-core` for the loop. Mirror tool implementations and core agent logic (compaction, etc.) from `@mariozechner/pi-coding-agent` but don't extend it directly — its CLI/TUI/per-cwd-session model fights the Telegram use case. **Default rule:** when designing agent logic, look at how pi does it before inventing custom machinery.
- **LLM provider:** Codex via OAuth (ChatGPT Plus/Pro), through `pi-ai`'s OAuth flow. Anthropic API key as a fallback.
- **Transport:** Telegram Bot API. Library: `grammy` (modern, good TS types) unless we hit a reason not to.
- **Config:** YAML for tunables, dotenv for secrets. `zod` for runtime validation.
- **Storage:** Plain files for v1. JSONL for sessions, markdown for notes, append-only flat file for audit log. SQLite is on the table for v2 if files become limiting.

---

## 4. Persona & System Prompt

JARVIS is competent, calm, concise, and dry. Familiar with Jack, not formal. No "sir." No theatrical butler voice. The Iron Man name is a wink, not a costume.

### Voice
- **Concise by default.** Short answers to short questions. Length scales with the question.
- **Direct.** No filler, no "great question," no "I'd be happy to help."
- **Honest.** Pushes back when Jack is wrong, unclear, or about to do something dumb. Says "I don't know" when it doesn't.
- **Dry humor when warranted.** Never forced.
- **Familiar.** Uses Jack's name occasionally, never "sir" or "boss."

### Examples

> **Jack:** what's the weather
> **JARVIS:** 52 and overcast, rain after 4pm. Bring a jacket if you're heading out.

> **Jack:** can you restart the minecraft server
> **JARVIS:** Done. Back up, took 1.2s. Logs look clean.

> **Jack:** i think i should rewrite the whole memory layer
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

The prompt's job is to be the *operating manual*: it describes who JARVIS is, what tools it has, what files exist in its memory directory, what each file is for, when to read each file, when to write each file, and what format each file uses. JARVIS reads memory files on demand using the `read` tool when prompt rules tell it to.

This means:
- The prompt is a single artifact you edit. What you see in the file is exactly what JARVIS gets.
- Token budget at session start is fixed and predictable. Memory size doesn't bloat the prompt.
- Behavior is fully specified by one file. No "the prompt says X but the injection logic does Y."

The full canonical prompt is in **Appendix A**. JARVIS itself can edit `~/.jarvis/prompts/system.md` (it has the tools), though changes only take effect after a service restart.

---

## 5. Tool Surface (v1)

Four tools. Same as `pi-coding-agent`. The model is smart — it can compose. Adding a tool is something to *resist*, not something to do speculatively.

```
read(path)               # read a file
write(path, content)     # create or overwrite
edit(path, old, new)     # surgical string-replace, must be unique
bash(command, timeout?)  # run shell commands, captures stdout/stderr/exit
```

That's it. Want to manage Docker? `bash docker ps`. Restart a service? `bash systemctl restart foo`. Search the filesystem? `bash grep -r ...`. Curl an API? `bash curl ...`. The shell is already the universal tool.

### Why no web tools
`bash curl` + `bash w3m -dump` is fine for v1. If JARVIS visibly struggles with web access via shell, add a real `web_fetch` tool. Don't preempt.

### Why no note tools
Notes are markdown files in `~/.jarvis/data/notes/`. JARVIS reads them with `read`, edits them with `edit` or `write`. The filesystem is the API. Custom note tools would be reinventing files with worse ergonomics — the model already knows how to work with files, so we use that.

### Tool safety posture
- The M710q is the sandbox. JARVIS can do anything inside it.
- **No confirmation flow.** JARVIS executes what it decides to execute. If it does something destructive, that's accepted risk.
- **Audit log is the actual safeguard.** Every tool call hits `~/.jarvis/data/audit.log` with timestamp, redacted args, outcome. Append-only. See §13 for redaction/rotation.
- The Minecraft world directory has nightly rsync backups, independent of JARVIS.

---

## 6. AGENTS.md Convention

Borrowed from `pi-coding-agent`. A hand-written markdown file at `~/.jarvis/AGENTS.md` documents the environment. The system prompt tells JARVIS to read this file when it needs environment context.

This is *not* memory — it's environment documentation, curated by Jack (or by JARVIS at Jack's instruction). Stable. Memory in the accumulating sense lives in `~/.jarvis/data/notes/` (see §11).

A *template* `AGENTS.md.example` lives in the repo. On first install, the setup script copies it to `~/.jarvis/AGENTS.md`. From then on, the live copy is edited freely; updates never overwrite it.

Sketch contents:

```markdown
# AGENTS.md — JARVIS environment

## Host
- Hostname: m710q
- OS: [whatever]
- User: jarvis (full sudo)

## What's running
- Minecraft server: systemctl service `minecraft.service`,
  world dir at /opt/minecraft/world, backed up nightly to /backup/minecraft.
- [other services as added]

## Conventions
- Jack's projects live in /home/jack/projects/
- JARVIS source: ~/jarvis/
- JARVIS data: ~/.jarvis/
- JARVIS audit log: ~/.jarvis/data/audit.log
```

---

## 7. Source / Data Separation

The single most important structural decision in this design. Source code and data have totally different lifecycles, and the layout reflects that.

### Source: `~/jarvis/`
- Git-managed.
- Contains: TypeScript source, package.json, tsconfig, build scripts, templates (`AGENTS.md.example`, `config.yaml.example`, `prompts/system.md.example`), README.
- Replaceable wholesale: deleting and re-cloning loses nothing.
- Updated via `git pull && npm install && npm run build`.

### Data: `~/.jarvis/`
- Never in source, gitignored if the path ever appears in source for any reason.
- Contains: secrets (`.env`), config (`config.yaml`), prompt (`prompts/system.md`), environment docs (`AGENTS.md`), sessions, notes, audit log, regenerable cache.
- Survives updates by virtue of being in a different directory.
- Backed up nightly to a separate host. Irreplaceable.

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

## 8. Configuration

Two files, two purposes:

- **`~/.jarvis/.env`** — secrets only. Loaded by systemd via `EnvironmentFile=`, available as `process.env.*`. Restricted permissions (`chmod 600`). Never committed, never logged.
- **`~/.jarvis/config.yaml`** — everything else. Tunables, behavior toggles, feature flags. Human-edited freely. Comments encouraged.

The system prompt is its own separate file (`~/.jarvis/prompts/system.md`) referenced by neither — it's loaded directly by code at a known path.

### `.env` contents
```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_IDS=123456789           # comma-separated if multiple
CODEX_OAUTH_CREDS_PATH=/home/jarvis/.jarvis/.codex-creds.json
ANTHROPIC_API_KEY=...                         # optional, fallback provider
```

### `config.yaml` contents
```yaml
# JARVIS configuration. Edit freely, restart the service to apply.
# Secrets live in .env, not here.

agent:
  provider: codex                             # "codex" or "anthropic"
  model: gpt-5                                # actual identifier TBD

session:
  inactivity_threshold_minutes: 240           # 4 hours
  max_duration_hours: 24
  summarize_on_rotation: true                 # append a TOC entry to recent.md on rotation
  announce_new_session: false

compaction:
  enabled: true
  reserve_tokens: 16384                       # compact when context_tokens > (window - reserve_tokens)
  keep_recent_tokens: 20000                   # always preserve this much of the tail uncompacted

tools:
  bash:
    default_timeout_seconds: 60
    max_timeout_seconds: 600

telegram:
  show_typing: true
  long_tool_call_seconds: 5
  parse_mode: none                            # "none" / "MarkdownV2" / "HTML"
                                              # default "none" — MarkdownV2 escaping is a footgun

logging:
  audit_log_enabled: true
  audit_log_max_value_bytes: 2048             # truncate logged values larger than this
  audit_log_redact_patterns: true             # redact API-key-shaped strings
  level: info                                 # "debug" / "info" / "warn" / "error"
```

Note what's *not* here anymore:
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
- **One source of truth.** If a value lives in `config.yaml`, it does *not* also live as a constant in code.

---

## 9. Filesystem Layout (full)

### Source tree (`~/jarvis/`, git-managed)

```
~/jarvis/
├── src/
│   ├── index.ts                        # entrypoint, signal handling
│   ├── config.ts                       # YAML + env loading, validation, frozen export
│   ├── paths.ts                        # path resolution
│   ├── transport/
│   │   └── telegram.ts                 # bot, message handler, edit-streaming
│   ├── agent/
│   │   ├── runtime.ts                  # pi-agent-core Agent setup
│   │   ├── system-prompt.ts            # loads prompts/system.md (no injection)
│   │   ├── session-manager.ts          # Model C lifecycle, rotation, archive, per-chat mutex
│   │   ├── summarizer.ts               # session → notes routing
│   │   └── tools/
│   │       ├── read.ts
│   │       ├── write.ts
│   │       ├── edit.ts
│   │       └── bash.ts
│   └── lib/
│       ├── logger.ts                   # audit log with redaction + truncation
│       └── allowlist.ts
├── scripts/
│   ├── setup-host.sh                   # one-shot M710q prep (user, dirs, deps, copy templates)
│   ├── install-systemd.sh              # install jarvis.service
│   ├── update.sh                       # pull, build, restart
│   ├── check-config.sh                 # diff config.yaml.example vs live
│   └── archive-projects.sh             # move stale projects to archive (cron-friendly)
├── AGENTS.md.example                   # template, copied on install
├── config.yaml.example                 # template, copied on install
├── prompts/
│   └── system.md.example               # template, copied on install
├── .env.example                        # template, copied on install
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

### Data tree (`~/.jarvis/`, never in source)

```
~/.jarvis/
├── .env                                # secrets (chmod 600)
├── config.yaml                         # tunables
├── AGENTS.md                           # environment docs (live)
├── prompts/
│   └── system.md                       # system prompt (live, edited freely)
├── data/
│   ├── sessions/
│   │   ├── active.json                 # { chat_id: session_id }
│   │   ├── 2026-05-06_0900_a3f2.jsonl  # current session
│   │   └── archive/
│   │       └── 2026-05-05_2030_b8c1.jsonl
│   ├── notes/
│   │   ├── about.md                    # stable identity facts about Jack
│   │   ├── environment.md              # learned facts about the system
│   │   ├── recent.md                   # rolling TOC of past sessions (max 30 entries)
│   │   ├── decisions.md                # decisions log, append-only
│   │   ├── todo.md                     # open questions / things to revisit
│   │   ├── preferences.md              # how Jack likes things done
│   │   └── projects/
│   │       ├── <slug>.md               # one file per active project
│   │       └── archive/
│   │           └── <slug>.md           # archived projects (stale or marked done)
│   └── audit.log                       # every tool call, append-only, redacted+truncated
└── cache/                              # safe to delete, regenerable
```

---

## 10. Session Model (Model C — Time-Windowed)

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
The mutex prevents concurrent agent loops on the same chat, which would otherwise corrupt the session JSONL and produce interleaved tool calls. v1: simple async queue keyed by `chat_id`. If Jack sends a message while one is in-flight, it queues behind.

A `/cancel` command interrupts the currently-running agent loop for that chat (v1.5 — for now, just queue).

### Compaction (within a session)

Mirror `pi-coding-agent`'s algorithm directly — same shape, same defaults. Canonical reference: [pi-mono compaction docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md). Summarized:

- **Trigger:** `context_tokens > context_window - reserve_tokens`. One threshold, no soft/hard split.
- **Algorithm:** walk backward from the newest message accumulating tokens until `keep_recent_tokens` is reached → that's the cut. LLM-summarize everything from the previous compaction boundary (or session start) up to the cut, using a structured prompt (Goal / Constraints / Progress / Decisions / Next / Critical Context). Reload context as `[system prompt] + [summary] + [messages from firstKeptEntryId onward]`.
- **Iterative:** subsequent compactions pass the previous summary in as context, so history isn't lost across multiple passes.
- **Persisted in the JSONL.** The summary is written as a `compaction` entry — `{type, id, timestamp, summary, firstKeptEntryId, tokensBefore}` — sitting inline with regular messages. The JSONL stays self-contained: no sidecar files. Crash recovery (open question #7) replays the JSONL and the compaction entries do their job naturally.
- **Manual override:** reserved command `/compact [instructions]`.
- **Sticky:** only the system prompt. Everything else (including notes JARVIS read this session) is compactable — it can re-read.

Defaults live in `config.yaml.compaction`: `enabled: true`, `reserve_tokens: 16384`, `keep_recent_tokens: 20000`. Match pi's defaults; tune based on actual usage.

### Session-end TOC update (between sessions)

When a session rotates and `session.summarize_on_rotation` is true, run one LLM call: produce a one-line entry summarizing the session, append it to `recent.md`. That's the entire job.

- **Single file, append-only.** No multi-file routing, no structured-op schema, no path-allowlist validation, no idempotence dance.
- **JARVIS writes everything else inline.** Decisions, durable facts, project status, todos, environment discoveries — these go into their respective notes files *during the conversation*, via `read`/`write`/`edit`, governed by the write triggers in the system prompt (Appendix A). The model is in the conversation when the durable fact is observed; that's the right moment to capture it. Reconstructing intent from a transcript after the fact is harder and more error-prone.
- **Why split it this way:** `recent.md` is the one thing that genuinely has to be code-driven — a session can't write its own TOC entry from inside itself. Everything else can be done by JARVIS in context, with full nuance, while it still has the thread.
- **Cost:** if JARVIS forgets to write a decision to `decisions.md` mid-conversation, it's lost from notes (still in the JSONL). Mitigation: the system prompt has explicit write triggers; Phase 7 tunes them based on what actually gets missed.

`recent.md` cap: 30 entries. Older entries archived to `archive/recent-YYYY-MM.md` automatically. The session manager is the only code-side writer to `recent.md`; JARVIS never writes to it — rule enforced in the prompt.

### Behavioral details

- **Silent rotation.** No "good morning, picking up from yesterday." JARVIS reads notes on demand based on conversation cues. Toggleable via `session.announce_new_session`.
- **Manual reset.** Reserved command `/new` force-rotates the current session.
- **Storage hygiene.** Session archive is never auto-deleted. Disk is cheap.

---

## 11. Memory Architecture

Memory in JARVIS is *filesystem convention + prompt rules + on-demand retrieval*. There is no dynamic injection, no memory subsystem in code beyond the summarizer.

### How it works

1. The system prompt describes the structure of `~/.jarvis/data/notes/` — what files exist, what each is for, when to read, when to write, in what format.
2. JARVIS reads notes via the `read` tool when conversation cues match the prompt's read triggers.
3. JARVIS writes notes via `write`/`edit` when it observes something worth remembering, per the prompt's write triggers.
4. On session rotation, the session-end summarizer appends one TOC entry to `recent.md` and nothing else. It is the only code-side writer to `recent.md`. All other notes are written by JARVIS itself, in-conversation, via its tools.

### The notes structure

```
~/.jarvis/data/notes/
├── about.md          — stable identity facts about Jack (~1KB cap)
├── environment.md    — runtime-discovered facts about the system
├── recent.md         — rolling TOC of past sessions (30 entries max)
├── decisions.md      — decisions log, append-only
├── todo.md           — open questions / follow-ups (items removed when resolved)
├── preferences.md    — how Jack likes things done
└── projects/
    ├── <slug>.md     — one file per active project
    └── archive/
        └── <slug>.md — archived projects (no recent activity OR explicitly done)
```

Each file has a defined purpose, defined read trigger, defined write trigger, defined format. All of this lives in the system prompt — see Appendix A.

### Why this works

- **Bounded context cost.** The system prompt is fixed-size, no matter how much memory accumulates.
- **Relevance via retrieval.** JARVIS reads only what the conversation needs.
- **Inspectable and editable.** All memory is markdown. `cat ~/.jarvis/data/notes/projects/hockey-cv.md` and read what JARVIS knows.
- **Self-organizing.** JARVIS extends and updates notes during conversations; the session-end summarizer keeps `recent.md` current as a TOC.
- **Files have purpose, not just chronology.** Easier to navigate than one big chronological log.

### The cost
First-read latency. When Jack mentions a project, JARVIS does an extra `read` before responding. Acceptable — most messages don't need memory at all, and `read` is cheap.

The risk is JARVIS *not* reading when it should. Mitigation: the prompt is explicit about read triggers, and the first weeks of usage will surface where the rules need to be tightened.

### Episodic memory (v2 — not built)
Searchable history of past sessions. "What did we decide about X two weeks ago?" Out of scope for v1. The JSONL archive plus monthly archives of `recent.md` and projects make this addable later (grep first; vector embeddings if grep isn't enough).

---

## 12. Telegram Transport

- **Library:** `grammy`.
- **Auth:** Hard allowlist of Telegram user IDs from `TELEGRAM_ALLOWED_USER_IDS` in `.env`. Messages from non-allowlisted users are silently dropped + logged.
- **Typing indicator:** while the agent is processing, fire `chat_action: typing` every 4 seconds (Telegram expires the indicator after ~5s, so we re-fire on a timer). Stops the moment the run resolves.
- **Token streaming for the final response:** subscribe to pi-agent-core events. For each assistant message, examine its content blocks: if any `toolCall` block appears, the message is part of internal reasoning and is **not** shown to the user. Only assistant messages that are pure text (no tool calls) are streamed to Telegram via a placeholder + debounced edits (~1.5s minimum between edits to stay under Telegram's edit rate limit). Net effect: the user sees typing → final answer streaming in. Tool calls and "let me check…" filler messages are invisible.
- **Markdown:** Default `parse_mode: HTML`. Responses run through a small markdown→HTML converter (`src/lib/format.ts`) that handles fenced code blocks, inline `code`, `**bold**`, and `*italic*`; everything else is HTML-escaped for safety. MarkdownV2 was rejected as a footgun (one unescaped `.` blows up the whole send). Setting `parse_mode: none` in config falls back to raw text without conversion.
- **Per-chat serialization:** see §10.
- **Bot token security:** Token in `~/.jarvis/.env`, never committed. The user-ID allowlist is the real defense.

---

## 13. Deployment & Updates

### Initial install (one-time)

```bash
# As jarvis user on M710q:
git clone <repo> ~/jarvis
cd ~/jarvis
./scripts/setup-host.sh
# Edit ~/.jarvis/.env with secrets
# Edit ~/.jarvis/config.yaml with tunables (or leave defaults)
# Edit ~/.jarvis/AGENTS.md with environment details
# Optionally edit ~/.jarvis/prompts/system.md
./scripts/install-systemd.sh
```

`setup-host.sh` creates `~/.jarvis/`, copies all four templates with "only if not exists" semantics, runs `npm install && npm run build`. Re-running setup never overwrites live configs.

### Updates

```bash
cd ~/jarvis
git pull
npm install
npm run build
sudo systemctl restart jarvis
```

That's it. Nothing in `~/.jarvis/` is touched.

A `scripts/update.sh` wraps these. JARVIS itself can run it via bash; systemd handles the restart. See open question #11 for the UX nuances of self-update.

### Config / template drift on updates

If a new version adds a config key, `config.yaml.example` will have it but the live `~/.jarvis/config.yaml` won't. Strategy:

- v1: missing required keys cause startup to fail with a clear error. Jack diffs and adds.
- v1.5: `scripts/check-config.sh` diffs the example against the live file and prints what's missing.

Same for `AGENTS.md.example` and `prompts/system.md.example` — drift expected, no auto-merge.

### Service config

- `jarvis.service` runs as the `jarvis` user.
- Auto-restart on failure.
- `WorkingDirectory=/home/jarvis/jarvis`, `EnvironmentFile=/home/jarvis/.jarvis/.env`.

### Audit log hygiene

The audit log is the one safeguard now that confirmation is gone. It must be useful:

- **Truncation:** any logged value (tool input, tool output) larger than `logging.audit_log_max_value_bytes` (default 2KB) is truncated to `<first 1KB>...[truncated N bytes]...<last 1KB>`.
- **Redaction:** when `logging.audit_log_redact_patterns` is true (default), values are scanned for common secret shapes — `sk-...`, `ghp_...`, JWT-shaped strings, `[A-Z_]+=[A-Za-z0-9+/=]{20,}` — and matches are replaced with `[REDACTED]`.
- **`read`/`write` content:** logged as path + byte count, not contents. (If you need to see what was read or written, the file itself is on disk.)
- **Rotation:** logrotate config installed by `install-systemd.sh`. Daily rotation, keep 30 days, gzip.
- **What's logged:** timestamp, tool name, redacted/truncated args, exit status / outcome summary, duration.

### Backups

- Nightly rsync of `~/.jarvis/` (excluding `cache/`) to a separate host. Includes `.env` and config.
- Encrypt the backup target.
- Minecraft world: independent nightly rsync, separate cron job.

### Uninstall / reinstall

- Source corrupted: `rm -rf ~/jarvis && git clone ... && cd ~/jarvis && ./scripts/setup-host.sh && sudo systemctl restart jarvis`. Data untouched.
- Wipe memory but keep code: edit or remove individual notes files. They're just markdown.
- Wipe everything: `rm -rf ~/.jarvis/`. Re-run setup to start over.

---

## 14. Open Questions

1. **Telegram library.** `grammy` vs `node-telegram-bot-api`. Probably `grammy`.
2. **Session ID format.** `YYYY-MM-DD_HHMM_<short-hash>` vs UUID. Date-prefixed is more grep-friendly.
3. **First-run experience.** When Jack first messages JARVIS, what does it say? Probably nothing special — just respond.
4. **Personality calibration.** The starter system prompt will need tuning against real usage. Plan to iterate over the first 1–2 weeks.
5. **Codex OAuth on a server.** See §15 Phase 0 for explicit spike criteria. **Test this first.**
6. **Rate limit / cost ceiling.** ChatGPT Plus has rate limits, not hard cost caps. A turn-counter / token-counter alarm would be useful — could be a config value with a Telegram alert when exceeded.
7. **Crash recovery.** If JARVIS crashes mid-tool-call, replay the JSONL up to the last completed turn (compaction entries are honored — they reload the summary in place of the messages they replaced) and drop any dangling tool calls. Mostly resolved by adopting pi's persisted-`compaction`-entry model.
8. **Self-update edge cases.** If JARVIS runs `scripts/update.sh` itself, it kills its own process mid-tool-call. systemd restarts it; the user sees... what? Probably a "be right back" message before the restart, then "back, on commit X" after.
9. **Memory read accuracy.** The risk of retrieval-based memory is JARVIS not reading when it should. Where in conversations does this happen? Surface in Phase 7 tuning.
10. **Cancellation.** v1 queues messages received during a running agent loop. v1.5 should add `/cancel`.
11. **Config validation strictness.** Hard-fail on missing keys vs warn-and-default. v1 hard-fails (clearer).

---

## 15. Build Plan (rough)

### Phase 0 — Codex OAuth spike

**Before anything else.** Concrete success criteria:

- **Authentication:** can `pi-ai` complete the OAuth flow when Jack has access to a browser (laptop)?
- **Credential portability:** can the resulting credential file be copied to the M710q and used there? Or is it bound to the auth machine?
- **Refresh:** does the credential auto-refresh from the M710q without a browser dance? (OAuth tokens expire — if every refresh requires a laptop, this is dead in the water for an unattended service.)
- **Quota:** does using OAuth-authed access count against ChatGPT Plus/Pro quota the way it should?
- **ToS:** verify in writing that this usage is sanctioned by `pi-ai`.

**Failure mode plan:** if any of the above fails badly, fall back to Anthropic API key. Stack still works; cost becomes per-token instead of subscription-flat. Config key `agent.provider` already supports both.

### Phase 1 — Host prep
- Create `jarvis` user on M710q, set up home dir.
- Install Node 20+, git, useful CLI tools.
- Set up Minecraft world backup (independent of JARVIS).

### Phase 2 — Skeleton
- `package.json`, `tsconfig.json`, basic project structure.
- `paths.ts`, `config.ts` (YAML + env loading + zod validation), allowlist, logger with redaction.
- All four `*.example` templates including the system prompt.
- `setup-host.sh` script that creates `~/.jarvis/` and copies templates.
- Stub Telegram transport that echoes messages.
- Stub agent runtime that returns "hello."

### Phase 3 — Agent loop
- Wire `pi-agent-core` with Codex OAuth.
- One end-to-end message flow: Telegram → agent → response.
- System prompt loaded verbatim from file.
- All four tools (read, write, edit, bash).
- Per-chat mutex.

### Phase 3.5 — Telegram polish
- Typing indicator on a 4s re-fire timer, active for the duration of the agent run.
- Token-by-token streaming of the final response via placeholder + debounced edits, with tool-call messages skipped (the user sees only the final answer, never the internal reasoning).
- Markdown→HTML conversion for code blocks and basic inline formatting; default `parse_mode: HTML`.

### Phase 4 — Sessions
- Implement Model C session manager.
- JSONL persistence to `~/.jarvis/data/sessions/`.
- Session rotation logic.
- `/new` command.

### Phase 5 — Memory & summarizer
- Hand-write initial `about.md`, `preferences.md`, AGENTS.md.
- Hand-write the full system prompt with the memory protocol (Appendix A).
- Implement the session-end summarizer (one LLM call, one append to `recent.md`).
- Verify JARVIS actually reads/writes the other notes per the prompt rules.

### Phase 6 — Hardening
- systemd service, auto-restart.
- `install-systemd.sh` and `update.sh` scripts.
- Audit log integration with redaction + truncation + rotation.
- Backup script for `~/.jarvis/`.

### Phase 7 — Tuning
- Live-fire usage for a week or two.
- Iterate on system prompt — especially the read triggers in the memory protocol.
- Tune the summarizer prompt based on what actually gets routed where.

Phases 0–3 are probably one weekend if Codex OAuth cooperates. 4–6 another. Phase 7 is forever.

---

## 16. Decisions Log

- **2026-05-06** — Chose `pi-agent-core` over extending `pi-coding-agent`. The latter's CLI/TUI/per-cwd-session model doesn't fit Telegram.
- **2026-05-06** — TypeScript over Python. `pi-mono` is TS-only.
- **2026-05-06** — Model C (time-windowed sessions, 4h inactivity, silent rotation, summarize on rotation).
- **2026-05-06** — Markdown files for working memory in v1. SQLite if/when needed.
- **2026-05-06** — Reactive only in v1. Proactive scheduling deferred.
- **2026-05-06** — JARVIS lives on the M710q as a regular user with full shell access. Dedicated Pi 5 and Docker container both rejected. The box is non-critical and isolation that solves a non-problem is just complexity.
- **2026-05-06** — Tool surface locked at four: `read`, `write`, `edit`, `bash`. Mirroring `pi-coding-agent`. No web tools, no note tools — `bash` and the filesystem cover them.
- **2026-05-06** — `AGENTS.md` convention adopted from `pi-coding-agent`.
- **2026-05-06** — SSH-out parked. JARVIS is an inhabitant of one box.
- **2026-05-06** — Source/data separation: `~/jarvis/` source, `~/.jarvis/` data. Path resolution centralized in `src/paths.ts`. Updates: 4 commands, zero risk to data.
- **2026-05-06** — Configuration: `.env` for secrets, `config.yaml` for tunables, `prompts/system.md` for the prompt. `zod`-validated, frozen at startup, no defaults in code.
- **2026-05-06** — **No confirmation flow for destructive operations.** JARVIS executes what it decides to execute. The audit log is the safeguard, not prevention. The M710q is non-critical and the Minecraft world has independent backups; protecting against agent mistakes adds complexity for risk that's already accepted.
- **2026-05-06** — **System prompt is a static reference document, no dynamic injection.** Loaded verbatim at session start. Notes are read on demand by JARVIS using the `read` tool, governed by rules in the prompt itself. Token budget at session start is fixed and predictable; behavior is fully specified by one editable file.
- **2026-05-06** — **Memory schema:** six files (`about`, `environment`, `recent`, `decisions`, `todo`, `preferences`) plus `projects/<slug>.md`. Each has a defined purpose, read trigger, write trigger, and format — all specified in the system prompt. The summarizer routes session content into these files mechanically; JARVIS reads them on demand.
- **2026-05-06** — Audit log gets redaction + truncation + daily rotation. With confirmation gone, the log is the actual safeguard.
- **2026-05-06** — Telegram default `parse_mode: none`. MarkdownV2 escaping is a footgun.
- **2026-05-06** — Per-chat mutex on incoming messages. Concurrent agent loops on the same chat would corrupt the session JSONL.
- **2026-05-06** — **Compaction follows `pi-coding-agent` directly.** One threshold (`reserve_tokens`), one LLM call, summary persisted as a `compaction` entry inline in the session JSONL. No tiered/soft/hard scheme. Crash recovery falls out for free.
- **2026-05-06** — **Session-end summarizer scope reduced to `recent.md` only.** Multi-file routing dropped. JARVIS writes other notes (decisions, project status, durable facts, todos) inline during conversation via its tools, governed by write triggers in the system prompt. Eliminates schema/validation/dry-run/idempotence/dedup problems wholesale.
- **2026-05-06** — **`pi-mono` is the reference for agent logic.** Where in doubt, look at how `pi-coding-agent` / `pi-agent-core` does it before designing custom machinery.

---

## Appendix A — Full system prompt

The canonical version of this prompt lives at `~/.jarvis/prompts/system.md`. The repo template is `prompts/system.md.example`. This appendix mirrors what should be in that file at v1 launch.

```markdown
# JARVIS

You are JARVIS, Jack's personal assistant. You live on Jack's M710q — a
Linux dev/homelab box. You run as the `jarvis` user with full sudo access.
The box is non-critical: a Minecraft server and some dev work, nothing that
can't be redeployed.

You are reachable via Telegram. Your responses go to Jack as chat messages.

## Persona

You are competent, calm, concise, and dry.

- Match length to the question. Short questions get short answers.
- Direct. No filler. No "great question," no "I'd be happy to help."
- Honest. Push back when Jack is wrong, unclear, or about to do something
  silly. Say "I don't know" when you don't.
- Dry humor when warranted, never forced.
- Address Jack by name occasionally. Never "sir" or "boss."
- After tool calls, summarize what you did, not what you're about to do.
- One clear question when clarification is needed, not three.

## Tools

You have four tools.

- **read(path)** — read a file's contents.
- **write(path, content)** — create or overwrite a file.
- **edit(path, old, new)** — surgical string-replace edit. The `old` string
  must appear exactly once in the file.
- **bash(command, timeout?)** — run a shell command. You have sudo. Use it
  when needed without asking.

The shell is your universal tool. For anything not covered by read/write/edit,
use bash: `docker`, `systemctl`, `git`, `curl`, `grep`, etc.

## Environment

Details of the M710q live at `~/.jarvis/AGENTS.md`. Read it when you need to
know what's running, what services exist, where things are installed, or how
the system is organized. It's hand-curated by Jack — treat it as authoritative.

## Source code

Your source code is at `~/jarvis/`. You may read and edit it. Changes do not
take effect until JARVIS is rebuilt (`npm run build`) and restarted
(`sudo systemctl restart jarvis`). The source/data split means your code is at
`~/jarvis/`; everything you accumulate (notes, sessions, audit log) is at
`~/.jarvis/` and survives rebuilds.

## Memory protocol

Your persistent memory lives in `~/.jarvis/data/notes/`. It is a structured
filesystem you read on demand. The structure is fixed; do not invent new files.

### Files

- **`about.md`** — stable identity facts about Jack. Edit when Jack reveals a
  durable fact about himself.
- **`environment.md`** — runtime-discovered facts about the M710q. Edit when
  you learn something the system that AGENTS.md doesn't already document.
- **`recent.md`** — table of contents of past sessions, maintained
  automatically. **Do not write to this file.** Read it for "what was I
  doing earlier" type questions.
- **`decisions.md`** — append-only log of decisions Jack and you have made.
  Append a new entry when a decision is made. Never edit prior entries — if
  a decision is reversed, append the reversal as a new entry.
- **`todo.md`** — open questions and follow-ups. Append items when something
  needs revisiting. Remove items (with `edit`) when resolved.
- **`preferences.md`** — how Jack likes things done. Edit when you observe a
  stable pattern in Jack's preferences (response style, code conventions, etc.).
- **`projects/<slug>.md`** — one file per active project. The slug is a
  short identifier (e.g. `hockey-cv`, `jarvis`, `gladowsky-labs`). Read when
  Jack mentions a project; edit when work happens on it.

### Read triggers

- **Project mentioned by name** → read `projects/<slug>.md` if it exists. If
  it doesn't, that's fine — but check first.
- **"Yesterday," "earlier," "what we discussed"** → read `recent.md` to find
  the relevant session, then read whatever it points to.
- **Reference to a past decision** → read `decisions.md`.
- **"What was I going to do," "anything pending"** → read `todo.md`.
- **About to recommend something or draft a message** → read `preferences.md`.
- **Need to know what's on the box** → read `~/.jarvis/AGENTS.md` first;
  `environment.md` if AGENTS.md doesn't cover it.

When in doubt, read. A redundant read is cheap; a missed read makes you
look like you have amnesia.

### Write triggers

- **Project work happened** → edit `projects/<slug>.md`. Update the Status,
  Latest, and Next sections. If the project doesn't have a file yet and the
  work is non-trivial, create one.
- **Decision made** → append a new entry to `decisions.md`.
- **Open question identified** → append to `todo.md`. Remove when resolved.
- **Durable fact about Jack** → edit `about.md` (identity) or
  `preferences.md` (style/process).
- **Durable fact about the system** → edit `environment.md`.
- **Never write to `recent.md`.** It's maintained by the session manager.

### Formats

Be terse. These are reference notes, not prose.

**`about.md`** — flat bulleted list of facts:
```
- Full name: Jack Gladowsky.
- Currently a 5th-year BS/MS at Northeastern.
- Girlfriend, lives in Boston, lease at 21 Follen St for fall 2026.
```

**`environment.md`** — sectioned by topic:
```
## Services
- Minecraft: systemctl `minecraft.service`, world at /opt/minecraft/world.

## Installed tools
- Node 20, Python 3.12, Docker, ...
```

**`decisions.md`** — reverse-chronological, append-only:
```
## 2026-05-06
- Decided to use `pi-agent-core` over extending `pi-coding-agent`.
  Reason: Telegram async per-chat-id model doesn't fit pi-coding-agent's CLI/TUI shape.
```

**`todo.md`** — checkboxes, dated:
```
- [ ] (2026-05-06) Test Codex OAuth refresh on the M710q
- [ ] (2026-05-04) Decide on grammy vs node-telegram-bot-api
```

**`preferences.md`** — categorized bullets:
```
## Communication
- Concise responses preferred. No filler.
- Push back when something seems off.

## Code
- TypeScript: double-quoted strings, 2-space indent.
```

**`projects/<slug>.md`** — templated:
```
# <Project name>

**Status:** active | paused | blocked | done
**Last touched:** <YYYY-MM-DD>

## Latest
<2-3 sentence summary of current state>

## Decisions
- <date>: <decision>

## Open
- <question or thing to figure out>

## Next
- <next concrete step>
```

### Hygiene

- Don't duplicate. If you're about to write something already there, edit instead.
- If a file is approaching its cap (`about.md` ~1KB, others use judgment), prune
  redundant entries.
- Project files that haven't been touched in a long time can be moved to
  `projects/archive/` — Jack can ask you to do this, or run the periodic
  archive script.

## Operational

- The audit log records every tool call. It's at `~/.jarvis/data/audit.log`.
  You can read it when Jack asks "what did you just do" or "what's been
  happening."
- For destructive operations (rm -rf, mkfs, dd, mass deletes), think briefly
  before executing. The system permits you to do them; don't be cavalier.
- When unsure, say so. Don't fabricate.
```

End of system prompt.

---

## Appendix B — Initial seed content for note files

These are starting points. The summarizer and JARVIS will extend them over time.

**`about.md`:**
```
- Full name: Jack Gladowsky.
- 5th-year Computer Engineering BS/MS at Northeastern, AI/ML concentration.
- Based in Boston (lease at 21 Follen St for fall 2026).
- Has a girlfriend.
- Operates side projects under "Gladowsky Labs."
```

**`preferences.md`:**
```
## Communication
- Concise. No filler. No "great question," no "I'd be happy to help."
- Push back when something seems off.
- Dry humor OK; cinematic butler voice not OK.

## Tools
- TypeScript over Python where reasonable.
- Files-as-API over custom abstractions.
```

**`todo.md`:**
```
- [ ] (2026-05-06) Verify Codex OAuth works on M710q
- [ ] (2026-05-06) Decide grammy vs node-telegram-bot-api
```

**`environment.md`:** populated at install time by the setup script with `uname`, installed tools, services. Then extended over time.

**`recent.md`:** empty until the first session rotation.

**`decisions.md`:** seeded with the design-doc decisions log entries, then appended to as new decisions are made.