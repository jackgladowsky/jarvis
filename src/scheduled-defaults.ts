import type { RecurringTask } from "./scheduler-logic.js";
import { paths } from "./paths.js";

const sourceSkill = (slug: string): string => `${paths.repo}/skills/${slug}/SKILL.md`;

const nightlyMemoryReviewPrompt = [
  "Run the nightly memory review for JARVIS.",
  "",
  "Purpose: review the previous scheduler-local calendar day's JARVIS session logs/summaries and conservatively update persistent memory markdown files where appropriate.",
  "",
  "Hard context budget:",
  "- Do not read huge files wholesale. Never `cat` or full-`read` `.jsonl` transcripts, `recent.md`, memory files, observability summaries, service units, or scheduled-task sessions.",
  "- Before inspecting any unknown-size file, run `wc -l`/`wc -c` or a bounded `ls -lh` first.",
  "- For markdown, use the `read` tool with `limit` or shell snippets like `head`, `tail`, `sed -n 'A,Bp'`, or `grep -A/-B` with small ranges.",
  "- For session JSONL, use targeted `rg -n -m`, `head`, `tail`, or `jq` projections that truncate message text with slicing such as `[0:500]`; inspect snippets only, not full transcripts.",
  "- Verification commands must print only changed sections or short snippets. If output is truncated, rerun a narrower command rather than expanding broadly.",
  "",
  "Procedure:",
  `1. Read \`${paths.agentsMd}\`, \`${sourceSkill("scheduler")}\`, and \`${sourceSkill("memory")}\` before making changes.`,
  `2. Determine the previous local date using the scheduler timezone from \`${paths.configYaml}\`. Inspect \`${paths.notes}/recent.md\` with bounded output to identify archived sessions touching that date. Also inspect \`${paths.activeSessions}\` and list non-archive \`${paths.sessions}/*.jsonl\` candidates by filename, mtime, active timestamps, or bounded message timestamp scans; these may not have rotated into recent.md yet.`,
  "3. Inspect only relevant archived or active session logs when summaries, filenames, active timestamps, or message timestamps suggest durable memory may exist. Start with bounded user-message/timestamp snippets and expand only around relevant lines.",
  "4. Update persistent memory only when a fact is durable, useful later, and clearly supported by the session record. Err on the side of re-checking candidate memories across runs rather than missing them, but dedupe before writing; repeated review is fine, duplicate notes are not.",
  `5. Allowed memory targets: \`environment.md\`, \`decisions.md\`, \`todo.md\`, \`preferences.md\`, and relevant \`projects/<slug>.md\` files under \`${paths.notes}/\`. Do not write \`recent.md\`. Do not create new top-level memory files.`,
  "6. Be aggressively selective: skip transient chat, routine command output, one-off errands, stale status chatter, and anything uncertain. No memory sludge.",
  "7. If a possible memory update has product/security/destructive implications or is ambiguous, do not guess. Record it in this scheduled task note as a thing to watch instead of changing memory.",
  "8. Before finishing, update this task note with the reviewed date, candidate files inspected, memory files changed, skipped/ambiguous items, and next things to watch. Keep it concise.",
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
