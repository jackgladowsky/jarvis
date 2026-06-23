# Memory

Use this skill whenever the owner refers to durable facts, past sessions, projects, decisions, preferences, pending work, or what JARVIS should remember.

Persistent memory lives in:

```text
~/.jarvis/data/notes/
```

It is a structured filesystem read on demand. Do not invent new top-level files.

## Files

- `about.md` — stable identity facts about the owner.
- `environment.md` — runtime-discovered host facts not already in `AGENTS.md`.
- `recent.md` — table of contents of past sessions; maintained automatically. Do not write to it.
- `decisions.md` — append-only decision log.
- `todo.md` — open questions and follow-ups.
- `preferences.md` — how the owner likes things done.
- `projects/<slug>.md` — one file per active project.

## Read triggers

- Project mentioned by name → read `projects/<slug>.md` if it exists.
- “Yesterday,” “earlier,” “what we discussed” → read `recent.md`; if needed, read archive JSONL at `~/.jarvis/data/sessions/archive/<session-id>.jsonl`.
- Past decision → read `decisions.md`.
- Pending work → read `todo.md`.
- Recommending something or drafting a message → read `preferences.md`.
- Need host facts → read `~/.jarvis/AGENTS.md` first; use `environment.md` if AGENTS does not cover it.

When in doubt, read. A redundant read is cheap; missed memory looks like amnesia.

## Write triggers

- Project work happened → update `projects/<slug>.md` Status, Latest, and Next. Create it if work is non-trivial and no file exists.
- Decision made → append to `decisions.md`.
- Open question identified → append to `todo.md`; remove when resolved.
- Durable fact about the owner → edit `about.md` or `preferences.md`.
- Durable fact about the system → edit `environment.md`.
- Never write to `recent.md`; the session manager owns it.

## Formats

Be terse. Reference notes, not memoirs.

### about.md

```markdown
- Full name: <owner name>.
- Work/school/context: <stable, useful fact>.
```

### environment.md

```markdown
## Services

- <service>: <how it runs>, <important paths>.

## Installed tools

- Node 22, Python 3.12, Docker.
```

### decisions.md

Reverse-chronological, append-only:

```markdown
## 2026-05-06

- Decided to use `pi-agent-core` over extending `pi-coding-agent`.
  Reason: Telegram async per-chat-id model does not fit pi-coding-agent.
```

### todo.md

```markdown
- [ ] (2026-05-06) Test Codex OAuth refresh on this host.
```

### preferences.md

```markdown
## Communication

- Concise responses preferred. No filler.

## Code

- TypeScript: double quotes, 2-space indent.
```

### projects/<slug>.md

```markdown
# <Project name>

**Status:** active | paused | blocked | done
**Last touched:** <YYYY-MM-DD>

## Latest

<2-3 sentence summary>

## Decisions

- <date>: <decision>

## Open

- <question>

## Next

- <next concrete step>
```

## Hygiene

- Do not duplicate entries.
- Edit existing facts when possible.
- Keep `about.md` small, about 1KB.
- Archive old project files under `projects/archive/` only when appropriate or asked.
