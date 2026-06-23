import type { RecurringTask } from "./scheduler-logic.js";

const nightlyMemoryReviewPrompt = [
  "Run the nightly memory review for JARVIS.",
  "",
  "Purpose: review the previous scheduler-local calendar day's JARVIS session logs/summaries and conservatively update persistent memory markdown files where appropriate.",
  "",
  "Procedure:",
  "1. Read `~/.jarvis/AGENTS.md`, `~/jarvis/SKILLS.md`, `~/jarvis/skills/scheduler/SKILL.md`, and `~/jarvis/skills/memory/SKILL.md` before making changes.",
  "2. Determine the previous local date using the scheduler timezone from `~/.jarvis/config.yaml`. Review `~/.jarvis/data/notes/recent.md` for archived sessions touching that date. Also read `~/.jarvis/data/sessions/active.json` and consider non-archive `~/.jarvis/data/sessions/*.jsonl` active session logs whose session id, active timestamps, or message timestamps overlap that date; these may not have been rotated into `recent.md` yet.",
  "3. Inspect only relevant archived or active session logs when summaries, filenames, active timestamps, or message timestamps suggest durable memory may exist. Do not summarize every transcript by default.",
  "4. Update persistent memory only when a fact is durable, useful later, and clearly supported by the session record. Err on the side of re-checking candidate memories across runs rather than missing them, but dedupe before writing; repeated review is fine, duplicate notes are not.",
  "5. Allowed memory targets: `environment.md`, `decisions.md`, `todo.md`, `preferences.md`, and relevant `projects/<slug>.md` files under `~/.jarvis/data/notes/`. Do not write `recent.md`. Do not create new top-level memory files.",
  "6. Be aggressively selective: skip transient chat, routine command output, one-off errands, stale status chatter, and anything uncertain. No memory sludge.",
  "7. If a possible memory update has product/security/destructive implications or is ambiguous, do not guess. Record it in this scheduled task note as a thing to watch instead of changing memory.",
  "8. Before finishing, update this task note with the reviewed date, files inspected, memory files changed, skipped/ambiguous items, and next things to watch. Keep it concise.",
  "",
  "Final response contract for notification routing:",
  "- First line must be exactly `NOTIFY: no` when the run completed normally and the owner does not need to see it.",
  "- First line must be exactly `NOTIFY: yes` only when the owner should be alerted about a real problem, ambiguity needing a decision, or notable memory change.",
  "- After that, provide at most 4 concise bullets summarizing reviewed date, changed files, and any action needed.",
].join("\n");

export const builtInScheduledTasks: RecurringTask[] = [
  {
    id: "nightly-memory-review",
    name: "Nightly memory review",
    schedule: "30 2 * * *",
    notify: "on_issue",
    prompt: nightlyMemoryReviewPrompt,
  },
];
