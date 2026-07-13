# JARVIS Skills

Skills are procedural references for JARVIS. They keep the core system prompt short while preserving detailed operating instructions.

## Convention

Skills live in two trees:

- **`~/jarvis/skills/<slug>/SKILL.md`** — general-purpose, source-controlled, committed to the repo. Structured tasks shared across installs.
- **`~/.jarvis/skills/<slug>/SKILL.md`** — host-local, never committed. Jack-specific workflows, hardware quirks, personal config, and environment oddities.

The skill index is `~/jarvis/SKILLS.md` (for source skills) and `~/.jarvis/skills/index.md` (for host-local skills).

Read the relevant skill on demand before doing work in that area. Prefer the skill over stale memory. If a skill conflicts with `~/.jarvis/AGENTS.md` for host facts, `AGENTS.md` wins.

Keep skills procedural and concise: triggers, steps, safety rules, paths, and examples. Do not load every skill by default. Read only what the current request needs.

Skills are self-improving — after complex tasks, create or update skills to document repeatable procedures. See the system prompt for the creation/improvement triggers.

## Available skills

- `background-workers` — creating, monitoring, reviewing, resuming, and cleaning background tasks.
- `deploy` — safe deploy/update flow, service restarts, setup, backups, and deployment safety.
- `release` — per-PR versioning flow: bumping `package.json`, updating `CHANGELOG.md`, and preparing the release PR.
- `scheduler` — recurring tasks, one-time reminders, job notes, sessions, and scheduler logs.
- `memory` — filesystem memory under `~/.jarvis/data/notes/`, read/write triggers, and formats.
- `destinations` — place recommendations, destination comparisons, and Uber/Lyft/Maps links.
- `github-pr` — preparing branches, review gates, pushing, and opening PRs.
- `host-ops` — host/service operations on the owner's Linux box.
- `web-search` — using the Exa-backed `web_search` tool effectively.
- `deep-research` — longer research workflow, source handling, and synthesis.
