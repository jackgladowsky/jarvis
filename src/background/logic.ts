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
  const wantsResearch = ["research", "investigate", "explore", "look into", "compare", "brainstorm"].some((word) =>
    lower.includes(word),
  );
  const wantsCode = ["implement", "build", "add", "fix", "update", "change", "pr", "code"].some((word) =>
    lower.includes(word),
  );
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
  provider: "codex";
  model: "gpt-5.6-sol" | "gpt-5.6-terra";
}

/**
 * Keep worker-stage routing local to background runs. Undefined deliberately
 * falls back to the active model rather than changing the main chat model.
 */
export function backgroundModelOverrideForRole(role: string): BackgroundModelOverride | undefined {
  switch (role) {
    case "planner":
    case "researcher":
    case "reviewer":
      return { provider: "codex", model: "gpt-5.6-sol" };
    case "implementer":
    case "fixer":
      return { provider: "codex", model: "gpt-5.6-terra" };
    default:
      return undefined;
  }
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
