import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { friendlyIdFromUuid, startBackgroundTask, readBackgroundTask } from "../background/manager.js";
import type { BackgroundStage } from "../background/types.js";
import { paths } from "../paths.js";
import { canStartGoalTask, classifyChildResult, goalDeadline, goalPrompt, normalizeGoalBudgets } from "./logic.js";
import type { GoalEvent, GoalStartOptions, GoalState, GoalStatus } from "./types.js";

function now(): string {
  return new Date().toISOString();
}

function goalPath(id: string): string {
  return join(paths.goalTasks, `${id}.json`);
}

function eventPath(id: string): string {
  return join(paths.goalEvents, `${id}.jsonl`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createGoalIdentity(): Promise<{ id: string; uuid: string }> {
  for (let i = 0; i < 20; i += 1) {
    const uuid = randomUUID();
    const id = `goal-${friendlyIdFromUuid(uuid)}`;
    if (!(await pathExists(goalPath(id)))) return { id, uuid };
  }
  const uuid = randomUUID();
  return { id: `goal-${uuid.slice(0, 8)}`, uuid };
}

export async function readGoal(id: string): Promise<GoalState> {
  return JSON.parse(await readFile(goalPath(id), "utf-8")) as GoalState;
}

export async function writeGoal(goal: GoalState): Promise<void> {
  await mkdir(paths.goalTasks, { recursive: true });
  goal.updated_at = now();
  await writeFile(goalPath(goal.id), JSON.stringify(goal, null, 2) + "\n", "utf-8");
}

export async function appendGoalEvent(id: string, event: Omit<GoalEvent, "ts">): Promise<void> {
  await mkdir(paths.goalEvents, { recursive: true });
  await appendFile(eventPath(id), JSON.stringify({ ts: now(), ...event }) + "\n", "utf-8");
}

export async function readGoalEvents(id: string, limit = 20): Promise<GoalEvent[]> {
  let raw: string;
  try {
    raw = await readFile(eventPath(id), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw.split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line) as GoalEvent);
}

export async function listGoals(): Promise<GoalState[]> {
  await mkdir(paths.goalTasks, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(paths.goalTasks)).filter((name) => name.endsWith(".json")).sort();
  const goals = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(paths.goalTasks, file), "utf-8")) as GoalState));
  return goals.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function startGoal(objective: string, chatId: number, options: GoalStartOptions = {}): Promise<GoalState> {
  const { id, uuid } = await createGoalIdentity();
  const created = now();
  const budgets = normalizeGoalBudgets(options);
  const goal: GoalState = {
    id,
    uuid,
    name: objective.split("\n")[0].slice(0, 80),
    objective,
    chat_id: chatId,
    status: "active",
    budgets,
    tasks_started: 0,
    failures: 0,
    task_ids: [],
    created_at: created,
    updated_at: created,
    deadline_at: goalDeadline(created, budgets.max_minutes),
  };
  await writeGoal(goal);
  await appendGoalEvent(id, { type: "created", body: `Goal created. Budget: ${budgetLabel(goal)}.` });
  await startNextGoalTask(goal, "initial task");
  return readGoal(id);
}

export async function startNextGoalTask(goalOrId: GoalState | string, reason = "manual next"): Promise<GoalState> {
  const goal = typeof goalOrId === "string" ? await readGoal(goalOrId) : goalOrId;
  if (goal.status === "paused") throw new Error(`${goal.id} is paused`);
  if (["done", "stopped", "failed"].includes(goal.status)) throw new Error(`${goal.id} is ${goal.status}`);
  goal.status = "active";
  const allowed = canStartGoalTask(goal);
  if (!allowed.ok) {
    goal.active_task_id = undefined;
    goal.stop_reason = allowed.reason;
    goal.status = allowed.done ? "done" : "failed";
    await writeGoal(goal);
    await appendGoalEvent(goal.id, { type: goal.status, body: allowed.reason });
    return goal;
  }

  const iteration = goal.tasks_started + 1;
  const pipeline: BackgroundStage[] = [
    { role: "researcher", status: "queued" },
    { role: "implementer", status: "queued" },
    { role: "reviewer", status: "queued" },
  ];
  const task = await startBackgroundTask(goalPrompt(goal, iteration), goal.chat_id, undefined, {
    goalId: goal.id,
    pipeline,
  });
  goal.tasks_started = iteration;
  goal.task_ids.push(task.id);
  goal.active_task_id = task.id;
  goal.stop_reason = undefined;
  await writeGoal(goal);
  await appendGoalEvent(goal.id, { type: "task_started", task_id: task.id, body: `${reason}; started ${task.id} (${iteration}/${goal.budgets.max_tasks})` });
  return goal;
}

export async function setGoalStatus(id: string, status: Extract<GoalStatus, "paused" | "stopped">, reason: string): Promise<GoalState> {
  const goal = await readGoal(id);
  goal.status = status;
  goal.stop_reason = reason;
  await writeGoal(goal);
  await appendGoalEvent(id, { type: status, body: reason, task_id: goal.active_task_id });
  return goal;
}

export async function resumeGoal(id: string): Promise<GoalState> {
  const goal = await readGoal(id);
  if (!["paused", "waiting_on_approval"].includes(goal.status)) throw new Error(`${id} is ${goal.status}, not paused/waiting`);
  if (goal.active_task_id) {
    goal.status = "active";
    goal.stop_reason = undefined;
    await writeGoal(goal);
    await appendGoalEvent(id, { type: "resumed", body: `resumed with active task ${goal.active_task_id}`, task_id: goal.active_task_id });
    return goal;
  }
  await appendGoalEvent(id, { type: "resumed", body: "resumed and starting next task" });
  return startNextGoalTask(goal, "resume");
}

export async function advanceGoalAfterBackgroundTask(taskId: string): Promise<GoalState | undefined> {
  const task = await readBackgroundTask(taskId);
  const goalId = task.goal_id;
  if (!goalId) return undefined;
  const goal = await readGoal(goalId);
  if (goal.active_task_id !== taskId) return goal;

  goal.active_task_id = undefined;
  const result = classifyChildResult(task);
  await appendGoalEvent(goal.id, { type: "task_finished", task_id: taskId, body: `${taskId} finished with ${task.status}` });

  if (goal.status === "stopped") {
    await writeGoal(goal);
    return goal;
  }
  if (goal.status === "paused") {
    goal.stop_reason = `paused after ${taskId} finished with ${task.status}`;
    await writeGoal(goal);
    await appendGoalEvent(goal.id, { type: "paused", task_id: taskId, body: goal.stop_reason });
    return goal;
  }

  if (result === "failed") {
    goal.failures += 1;
    goal.status = "failed";
    goal.stop_reason = `${taskId} finished with ${task.status}`;
    await writeGoal(goal);
    await appendGoalEvent(goal.id, { type: "failed", task_id: taskId, body: goal.stop_reason });
    return goal;
  }

  if (result === "blocked") {
    goal.status = "waiting_on_approval";
    goal.stop_reason = `${taskId} requires main review (${task.status})`;
    await writeGoal(goal);
    await appendGoalEvent(goal.id, { type: "waiting_on_approval", task_id: taskId, body: goal.stop_reason });
    return goal;
  }

  const allowed = canStartGoalTask(goal);
  if (!allowed.ok) {
    goal.status = allowed.done ? "done" : "failed";
    goal.stop_reason = allowed.reason;
    await writeGoal(goal);
    await appendGoalEvent(goal.id, { type: goal.status, body: allowed.reason, task_id: taskId });
    return goal;
  }

  if (!goal.budgets.auto_continue) {
    goal.status = "waiting_on_approval";
    goal.stop_reason = `task ${taskId} is ready; use /goal next ${goal.id} to spend another task budget`;
    await writeGoal(goal);
    await appendGoalEvent(goal.id, { type: "waiting_on_approval", task_id: taskId, body: goal.stop_reason });
    return goal;
  }

  await writeGoal(goal);
  return startNextGoalTask(goal, `auto-continue after ${taskId}`);
}

export function renderGoal(goal: GoalState): string {
  return [
    `${goal.id} — ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Budget: ${budgetLabel(goal)}`,
    `Tasks: ${goal.tasks_started}/${goal.budgets.max_tasks}${goal.active_task_id ? ` active:${goal.active_task_id}` : ""}`,
    goal.task_ids.length ? `Task IDs: ${goal.task_ids.join(", ")}` : undefined,
    goal.stop_reason ? `Stop reason: ${goal.stop_reason}` : undefined,
    `Deadline: ${goal.deadline_at}`,
  ].filter(Boolean).join("\n");
}

export function renderGoalList(goals: GoalState[]): string {
  if (goals.length === 0) return "No goals.";
  return goals.slice(0, 10).map((goal) => `${goal.id} — ${goal.status} — ${goal.tasks_started}/${goal.budgets.max_tasks}${goal.active_task_id ? ` active:${goal.active_task_id}` : ""} — ${goal.name}`).join("\n");
}

export function renderGoalEvents(events: GoalEvent[]): string {
  if (events.length === 0) return "No goal events.";
  return events.map((event) => `- ${event.ts} ${event.type}${event.task_id ? `/${event.task_id}` : ""}: ${event.body}`).join("\n");
}

function budgetLabel(goal: GoalState): string {
  return `tasks ${goal.budgets.max_tasks}, minutes ${goal.budgets.max_minutes}, failures ${goal.budgets.max_failures}, auto ${goal.budgets.auto_continue ? "on" : "off"}`;
}
