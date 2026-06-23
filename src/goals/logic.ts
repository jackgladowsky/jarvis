import type { BackgroundTask } from "../background/types.js";
import type { GoalBudgets, GoalStartOptions, GoalState } from "./types.js";

export const DEFAULT_GOAL_BUDGETS: GoalBudgets = {
  max_tasks: 1,
  max_minutes: 120,
  max_failures: 0,
  auto_continue: false,
};

export function normalizeGoalBudgets(options: GoalStartOptions = {}): GoalBudgets {
  return {
    max_tasks: boundedInt(options.maxTasks, DEFAULT_GOAL_BUDGETS.max_tasks, 1, 20),
    max_minutes: boundedInt(options.maxMinutes, DEFAULT_GOAL_BUDGETS.max_minutes, 1, 24 * 60),
    max_failures: boundedInt(options.maxFailures, DEFAULT_GOAL_BUDGETS.max_failures, 0, 10),
    auto_continue: options.autoContinue ?? DEFAULT_GOAL_BUDGETS.auto_continue,
  };
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function goalDeadline(createdAt: string, maxMinutes: number): string {
  return new Date(new Date(createdAt).getTime() + maxMinutes * 60_000).toISOString();
}

export function canStartGoalTask(goal: GoalState, now = new Date()): { ok: true } | { ok: false; reason: string; done?: boolean } {
  if (!goal.status || !["active", "waiting_on_approval"].includes(goal.status)) return { ok: false, reason: `goal is ${goal.status}` };
  if (goal.active_task_id) return { ok: false, reason: `task ${goal.active_task_id} is already active` };
  if (goal.tasks_started >= goal.budgets.max_tasks) return { ok: false, reason: `task budget exhausted (${goal.tasks_started}/${goal.budgets.max_tasks})`, done: true };
  if (now.getTime() >= new Date(goal.deadline_at).getTime()) return { ok: false, reason: "time budget exhausted", done: true };
  if (goal.failures > goal.budgets.max_failures) return { ok: false, reason: `failure budget exhausted (${goal.failures}/${goal.budgets.max_failures})` };
  return { ok: true };
}

export function goalPrompt(goal: GoalState, iteration: number): string {
  return [
    `Autonomous goal iteration ${iteration}/${goal.budgets.max_tasks}.`,
    `Goal: ${goal.objective}`,
    "",
    "Find and complete exactly one small, safe improvement toward this goal.",
    "Use the assigned git worktree only. Do not edit the main checkout.",
    "Do not push, merge, deploy, restart services, or run destructive operations unless Jack explicitly approves in the task mailbox.",
    "If the next useful step requires a product/security/destructive decision, ask main JARVIS and stop.",
    "Keep scope tight; prefer a design doc/roadmap if implementation is not obviously small and safe.",
    "Run reasonable checks and record them.",
    "This task is part of a bounded /goal loop; do not spawn new background tasks yourself.",
  ].join("\n");
}

export function classifyChildResult(task: Pick<BackgroundTask, "status">): "ready" | "blocked" | "failed" | "done" {
  if (task.status === "ready_for_pr" || task.status === "done") return "ready";
  if (task.status === "needs_fix" || task.status === "waiting_on_main") return "blocked";
  if (task.status === "failed" || task.status === "cancelled") return "failed";
  return "done";
}

export interface ParsedGoalStart {
  objective: string;
  options: GoalStartOptions;
}

export function parseGoalStartArgs(input: string): ParsedGoalStart | undefined {
  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const objectiveParts: string[] = [];
  const options: GoalStartOptions = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = unquote(tokens[i] ?? "");
    if (token === "--auto") {
      options.autoContinue = true;
      continue;
    }
    if (token === "--no-auto") {
      options.autoContinue = false;
      continue;
    }
    if (["--max-tasks", "--max-minutes", "--max-failures"].includes(token)) {
      const raw = unquote(tokens[i + 1] ?? "");
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) return undefined;
      if (token === "--max-tasks") options.maxTasks = value;
      if (token === "--max-minutes") options.maxMinutes = value;
      if (token === "--max-failures") options.maxFailures = value;
      i += 1;
      continue;
    }
    objectiveParts.push(token);
  }
  const objective = objectiveParts.join(" ").trim();
  if (!objective) return undefined;
  return { objective, options };
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}
