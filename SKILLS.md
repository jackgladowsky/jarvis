# JARVIS Skills

Skills are repo-local procedural references for JARVIS. They keep the core system prompt short while preserving detailed operating instructions.

## Convention

- The skill index is `~/jarvis/SKILLS.md`.
- Each skill lives at `~/jarvis/skills/<slug>/SKILL.md`.
- Read the relevant skill on demand before doing work in that area.
- Prefer the skill over stale memory. If a skill conflicts with `~/.jarvis/AGENTS.md` for host facts, `AGENTS.md` wins.
- Keep skills procedural and concise: triggers, steps, safety rules, paths, and examples.
- Do not load every skill by default. Read only what the current request needs.

## Available skills

- `background-workers` — creating, monitoring, reviewing, resuming, and cleaning background tasks.
- `deploy` — safe deploy/update flow, service restarts, setup, backups, and deployment safety.
- `scheduler` — recurring tasks, one-time reminders, job notes, sessions, and scheduler logs.
- `memory` — filesystem memory under `~/.jarvis/data/notes/`, read/write triggers, and formats.
- `destinations` — place recommendations, destination comparisons, and Uber/Lyft/Maps links.
- `github-pr` — preparing branches, review gates, pushing, and opening PRs.
- `host-ops` — host/service operations on Jack's Linux box.
- `web-search` — using the Exa-backed `web_search` tool effectively.
- `deep-research` — longer research workflow, source handling, and synthesis.
