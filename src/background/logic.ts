import { basename } from "node:path";
import type { BackgroundRole, BackgroundStage, BackgroundTask } from "./types.js";

const ID_LEFT = [
  "ash",
  "blue",
  "bold",
  "calm",
  "cedar",
  "clear",
  "cove",
  "dawn",
  "dusk",
  "fern",
  "frost",
  "glow",
  "gray",
  "green",
  "hush",
  "iron",
  "jade",
  "kind",
  "lake",
  "lunar",
  "maple",
  "mint",
  "moss",
  "north",
  "nova",
  "onyx",
  "pine",
  "quiet",
  "river",
  "sage",
  "solar",
  "stone",
  "swift",
  "tide",
  "violet",
  "west",
  "wild",
  "young",
];
const ID_RIGHT = [
  "ant",
  "bear",
  "bird",
  "brook",
  "comet",
  "crow",
  "deer",
  "dove",
  "drake",
  "finch",
  "fox",
  "frog",
  "hare",
  "hawk",
  "lynx",
  "mole",
  "moth",
  "otter",
  "owl",
  "panda",
  "quail",
  "raven",
  "seal",
  "shark",
  "snail",
  "sparrow",
  "swan",
  "tiger",
  "trout",
  "wolf",
];

export function friendlyIdFromUuid(uuid: string): string {
  const compact = uuid.replace(/-/g, "");
  const leftIndex = Number.parseInt(compact.slice(0, 8), 16) % ID_LEFT.length;
  const rightIndex = Number.parseInt(compact.slice(8, 16), 16) % ID_RIGHT.length;
  return `${ID_LEFT[leftIndex]}-${ID_RIGHT[rightIndex]}`;
}

export function choosePipeline(prompt: string): BackgroundStage[] {
  const lower = prompt.toLowerCase();
  const wantsResearch = /\b(?:research|investigate|explore|compare|brainstorm|review|audit)\b|\blook\s+into\b/.test(
    lower,
  );
  const wantsCode =
    /\b(?:implement|build|add|fix|update|change|improve|refactor|patch|code|pr)\b|\bpull\s+request\b/.test(lower);
  if (wantsResearch && !wantsCode)
    return [
      { role: "researcher", status: "queued" },
      { role: "reviewer", status: "queued" },
    ];
  if (wantsResearch && wantsCode) {
    return [
      { role: "researcher", status: "queued" },
      { role: "implementer", status: "queued" },
      { role: "reviewer", status: "queued" },
    ];
  }
  return [
    { role: "implementer", status: "queued" },
    { role: "reviewer", status: "queued" },
  ];
}

export interface BackgroundModelOverride {
  provider: "codex" | "anthropic" | "openrouter";
  model: string;
}

/**
 * Keep worker-stage routing local to background runs. Undefined deliberately
 * falls back to the active model rather than changing the main chat model.
 */
export function backgroundModelOverrideForRole(
  role: string,
  routes: Partial<Record<BackgroundRole, BackgroundModelOverride>> = {},
): BackgroundModelOverride | undefined {
  return routes[role as BackgroundRole];
}

export function backgroundWorkerInstructions(role: string): string[] {
  switch (role) {
    case "planner":
    case "researcher":
      return [
        `Role: ${role}.`,
        "Understand the repo/problem and produce a concise implementation plan, risks, and files likely involved.",
        "Do not edit files. Do not push, merge, deploy, or restart services.",
        "If this is purely a research task, produce the final answer and mark the stage done.",
      ];
    case "implementer":
      return [
        "Role: implementer.",
        "Implement the requested change in the assigned worktree only.",
        "Use prior researcher output/mailbox context if present.",
        "Run reasonable build/typecheck/tests and record exact commands/results.",
        "Do not push, merge, deploy, or restart services.",
      ];
    case "reviewer":
      return [
        "Role: reviewer.",
        "Review the completed work skeptically. Do not edit files.",
        "Inspect task note, mailbox, git status, git diff/stat, and rerun reasonable checks.",
        "Your final response must start with exactly `VERDICT: ready` or `VERDICT: needs_fix`.",
        "Then summarize scope, checks, risks, and concrete fix instructions if needed.",
      ];
    case "fixer":
      return [
        "Role: fixer.",
        "Make the smallest changes needed to address reviewer feedback in the worktree only.",
        "Run reasonable checks. Do not push, merge, deploy, or restart services.",
      ];
    default:
      return [
        `Role: ${role}.`,
        "No specialized instructions exist for this role; use the original request and prior stage context.",
        "Work only in the assigned worktree and do not push, merge, deploy, or restart services.",
      ];
  }
}

/** Appends the single bounded automatic remediation cycle after a failed review. */
export function appendAutomaticFixerCycle(task: Pick<BackgroundTask, "pipeline" | "automatic_fix_attempted">): boolean {
  if (task.automatic_fix_attempted) return false;
  task.automatic_fix_attempted = true;
  task.pipeline.push({ role: "fixer", status: "queued" }, { role: "reviewer", status: "queued" });
  return true;
}

export function nextQueuedRole(task: Pick<BackgroundTask, "pipeline">): BackgroundRole | undefined {
  return task.pipeline.find((stage) => stage.status === "queued")?.role;
}

export function renderPipeline(task: Pick<BackgroundTask, "pipeline">): string {
  return task.pipeline.map((stage) => `${stage.role}:${stage.status}`).join(" -> ");
}

export function renderTask(task: BackgroundTask): string {
  return [
    `${task.id} — ${task.status}`,
    `UUID: ${task.uuid}`,
    `Pipeline: ${renderPipeline(task)}`,
    task.current_role ? `Current role: ${task.current_role}` : undefined,
    `Branch: ${task.branch}`,
    `Worktree: ${task.worktree}`,
    task.goal_id ? `Goal: ${task.goal_id}` : undefined,
    task.pid ? `PID: ${task.pid}` : undefined,
    task.summary ? `Summary: ${task.summary}` : undefined,
    task.review_summary ? `Review: ${task.review_summary}` : undefined,
    task.error ? `Error: ${task.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderTaskList(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) return "No background tasks.";
  return tasks
    .slice(0, 10)
    .map((task) => {
      const current = task.current_role ? ` current:${task.current_role}` : "";
      return `${task.id} — ${task.status}${current} — ${renderPipeline(task)} — ${basename(task.worktree)}`;
    })
    .join("\n");
}
