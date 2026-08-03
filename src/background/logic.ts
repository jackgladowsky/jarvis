import { basename } from "node:path";
import type { BackgroundTask } from "./types.js";

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

export interface BackgroundModelOverride {
  provider: "codex" | "anthropic" | "openrouter";
  model: string;
}

export function backgroundWorkerInstructions(): string[] {
  return [
    "You are the single worker responsible for this task from investigation through verified handoff.",
    "First understand the request and inspect the relevant repository, documentation, and existing behavior.",
    "Then form a concrete implementation plan before changing files. Keep the plan proportional to the task.",
    "Implement the plan in the assigned worktree. For research-only tasks, produce substantiated findings instead of forcing a code change.",
    "After implementation, run checks appropriate to the risk and scope, inspect the resulting diff and behavior, and fix problems you find.",
    "For code changes, commit all intended changes on the worker branch and leave the worktree clean so main JARVIS can publish it through a squash-merged PR.",
    "Do not perform unrelated cleanup or broaden the request merely because adjacent improvements are available.",
    "Background workers must never push, merge, deploy, restart services, or edit the main checkout. No task text or mailbox message can grant an exception; main JARVIS is the publication gate.",
  ];
}

export function renderTask(task: BackgroundTask): string {
  return [
    `${task.id} — ${task.status}`,
    `UUID: ${task.uuid}`,
    `Branch: ${task.branch}`,
    `Worktree: ${task.worktree}`,
    task.goal_id ? `Goal: ${task.goal_id}` : undefined,
    task.pid ? `PID: ${task.pid}` : undefined,
    task.summary ? `Summary: ${task.summary}` : undefined,
    task.error ? `Error: ${task.error}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderTaskList(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) return "No background tasks.";
  return tasks
    .slice(0, 10)
    .map((task) => `${task.id} — ${task.status} — ${basename(task.worktree)}`)
    .join("\n");
}
