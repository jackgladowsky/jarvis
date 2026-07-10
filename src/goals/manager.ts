import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import {
  activateDeferredBackgroundTask,
  friendlyIdFromUuid,
  cancelBackgroundTask,
  launchBackgroundTask,
  listBackgroundTasks,
  startBackgroundTask,
  readBackgroundTask,
} from "../background/manager.js";
import type { BackgroundStage } from "../background/types.js";
import { paths } from "../paths.js";
import { atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { appendJsonLinesDurable, readJsonLinesRecovering } from "../lib/json-lines.js";
import { log } from "../lib/logger.js";
import { canStartGoalTask, classifyChildResult, goalDeadline, goalPrompt, normalizeGoalBudgets } from "./logic.js";
import type { GoalEvent, GoalStartOptions, GoalState, GoalStatus } from "./types.js";

const GOAL_ID_PATTERN = /^goal-(?:[a-z]+-[a-z]+|[0-9a-f]{8})$/;
const goalCreationLock = join(paths.goalTasks, ".goal-creation");

function now(): string {
  return new Date().toISOString();
}

function goalPath(id: string): string {
  assertGoalId(id);
  return join(paths.goalTasks, `${id}.json`);
}

function eventPath(id: string): string {
  assertGoalId(id);
  return join(paths.goalEvents, `${id}.jsonl`);
}

function assertGoalId(id: string): void {
  if (!GOAL_ID_PATTERN.test(id)) throw new Error(`invalid goal id: ${id}`);
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

function normalizeGoal(goal: GoalState): GoalState {
  assertGoalId(goal.id);
  goal.revision = goal.revision ?? 0;
  if (!Number.isSafeInteger(goal.revision) || goal.revision < 0) {
    throw new Error(`invalid goal revision for ${goal.id}`);
  }
  return goal;
}

async function readGoalUnlocked(id: string): Promise<GoalState> {
  const goal = normalizeGoal(JSON.parse(await readFile(goalPath(id), "utf-8")) as GoalState);
  if (goal.id !== id) throw new Error(`goal file ${id} contains state for ${goal.id}`);
  return goal;
}

export async function readGoal(id: string): Promise<GoalState> {
  return readGoalUnlocked(id);
}

async function writeGoalUnlocked(goal: GoalState, current?: GoalState): Promise<void> {
  await mkdir(paths.goalTasks, { recursive: true });
  let stored = current;
  if (!stored) {
    try {
      stored = await readGoalUnlocked(goal.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  if (stored && stored.uuid !== goal.uuid) throw new Error(`goal id collision: ${goal.id}`);
  const expectedRevision = goal.revision ?? 0;
  const storedRevision = stored?.revision ?? 0;
  if (stored && expectedRevision !== storedRevision) {
    throw new Error(
      `goal ${goal.id} changed concurrently (expected revision ${expectedRevision}, found ${storedRevision})`,
    );
  }
  const persisted: GoalState = { ...goal, updated_at: now(), revision: storedRevision + 1 };
  await atomicWriteJson(goalPath(goal.id), persisted);
  Object.assign(goal, persisted);
}

export async function writeGoal(goal: GoalState): Promise<void> {
  await withFileLock(goalPath(goal.id), () => writeGoalUnlocked(goal));
}

export async function appendGoalEvent(id: string, event: Omit<GoalEvent, "ts">): Promise<void> {
  await mkdir(paths.goalEvents, { recursive: true });
  await appendJsonLinesDurable(eventPath(id), JSON.stringify({ ts: now(), ...event }) + "\n");
}

export async function readGoalEvents(id: string, limit = 20): Promise<GoalEvent[]> {
  return (await readJsonLinesRecovering<GoalEvent>(eventPath(id))).slice(-limit);
}

export async function listGoals(): Promise<GoalState[]> {
  await mkdir(paths.goalTasks, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(paths.goalTasks)).filter((name) => name.endsWith(".json")).sort();
  const goals = (
    await Promise.all(
      files.map(async (file) => {
        try {
          return normalizeGoal(JSON.parse(await readFile(join(paths.goalTasks, file), "utf-8")) as GoalState);
        } catch (err) {
          log.warn("skipping unreadable goal state", {
            file,
            err: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      }),
    )
  ).filter((goal): goal is GoalState => goal !== undefined);
  return goals.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function startGoal(objective: string, chatId: number, options: GoalStartOptions = {}): Promise<GoalState> {
  const goal = await withFileLock(goalCreationLock, async () => {
    const { id, uuid } = await createGoalIdentity();
    const created = now();
    const budgets = normalizeGoalBudgets(options);
    const createdGoal: GoalState = {
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
      initial_task_pending: true,
      created_at: created,
      updated_at: created,
      deadline_at: goalDeadline(created, budgets.max_minutes),
    };
    await writeGoal(createdGoal);
    return createdGoal;
  });
  await appendGoalEvent(goal.id, { type: "created", body: `Goal created. Budget: ${budgetLabel(goal)}.` });
  await startNextGoalTask(goal.id, "initial task");
  return readGoal(goal.id);
}

export async function startNextGoalTask(goalOrId: GoalState | string, reason = "manual next"): Promise<GoalState> {
  const goalId = typeof goalOrId === "string" ? goalOrId : goalOrId.id;
  const token = randomUUID();
  let stopEvent: { type: "done" | "failed"; body: string } | undefined;
  const reservation = await withFileLock(goalPath(goalId), async () => {
    const goal = await readGoalUnlocked(goalId);
    if (goal.status === "paused") throw new Error(`${goal.id} is paused`);
    if (["done", "stopped", "failed"].includes(goal.status)) throw new Error(`${goal.id} is ${goal.status}`);
    if (goal.active_task_id) throw new Error(`${goal.id} already has active task ${goal.active_task_id}`);
    goal.initial_task_pending = undefined;
    const allowed = canStartGoalTask(goal);
    if (!allowed.ok) {
      goal.stop_reason = allowed.reason;
      goal.status = allowed.done ? "done" : "failed";
      await writeGoalUnlocked(goal, goal);
      stopEvent = { type: goal.status, body: allowed.reason };
      return { goal, iteration: 0, pendingId: "" };
    }
    const iteration = goal.tasks_started + 1;
    const pendingId = `pending:${token}`;
    goal.status = "active";
    goal.tasks_started = iteration;
    goal.active_task_id = pendingId;
    goal.stop_reason = undefined;
    await writeGoalUnlocked(goal, goal);
    return { goal, iteration, pendingId };
  });
  if (stopEvent) {
    await appendGoalEvent(goalId, stopEvent);
    return reservation.goal;
  }

  const pipeline: BackgroundStage[] = [
    { role: "researcher", status: "queued" },
    { role: "implementer", status: "queued" },
    { role: "reviewer", status: "queued" },
  ];
  let task;
  try {
    task = await startBackgroundTask(
      goalPrompt(reservation.goal, reservation.iteration),
      reservation.goal.chat_id,
      undefined,
      {
        goalId: reservation.goal.id,
        pipeline,
        deferStart: true,
      },
    );
  } catch (err) {
    const failed = await withFileLock(goalPath(goalId), async () => {
      const goal = await readGoalUnlocked(goalId);
      if (goal.active_task_id !== reservation.pendingId) return goal;
      goal.active_task_id = undefined;
      goal.tasks_started = Math.max(0, goal.tasks_started - 1);
      goal.failures += 1;
      goal.status = goal.failures > goal.budgets.max_failures ? "failed" : "waiting_on_approval";
      goal.stop_reason = `failed to create background task: ${err instanceof Error ? err.message : String(err)}`;
      await writeGoalUnlocked(goal, goal);
      return goal;
    });
    await appendGoalEvent(goalId, {
      type: failed.status === "failed" ? "failed" : "waiting_on_approval",
      body: failed.stop_reason ?? "failed to create background task",
    });
    throw err;
  }

  const link = await withFileLock(goalPath(goalId), async () => {
    const current = await readGoalUnlocked(goalId);
    if (current.active_task_id !== reservation.pendingId) {
      return { goal: current, linked: false, reservationChanged: true };
    }
    if (current.status !== "active") {
      current.active_task_id = undefined;
      current.tasks_started = Math.max(0, current.tasks_started - 1);
      await writeGoalUnlocked(current, current);
      return { goal: current, linked: false, reservationChanged: false };
    }
    current.task_ids.push(task.id);
    current.active_task_id = task.id;
    current.stop_reason = undefined;
    await writeGoalUnlocked(current, current);
    // Keep the goal lock through the deferred-task transition. A concurrent
    // pause/stop either wins before this lock (and cancels above) or observes
    // a durably linked child; it can never slip between the status check and
    // launch and accidentally start autonomous work from a paused goal.
    await activateDeferredBackgroundTask(task.id);
    await launchBackgroundTask(task.id);
    return { goal: current, linked: true, reservationChanged: false };
  });
  if (!link.linked) {
    await cancelBackgroundTask(task.id);
    if (link.reservationChanged) {
      throw new Error(`${goalId} task reservation changed before ${task.id} could be linked`);
    }
    await appendGoalEvent(goalId, {
      type: link.goal.status === "paused" ? "paused" : link.goal.status === "stopped" ? "stopped" : "failed",
      body: `Task creation finished after the goal became ${link.goal.status}; ${task.id} was cancelled before launch.`,
    });
    return link.goal;
  }
  await appendGoalEvent(link.goal.id, {
    type: "task_started",
    task_id: task.id,
    body: `${reason}; started ${task.id} (${reservation.iteration}/${link.goal.budgets.max_tasks})`,
  });
  return link.goal;
}

export async function setGoalStatus(
  id: string,
  status: Extract<GoalStatus, "paused" | "stopped">,
  reason: string,
): Promise<GoalState> {
  const goal = await withFileLock(goalPath(id), async () => {
    const current = await readGoalUnlocked(id);
    if (["done", "failed"].includes(current.status)) {
      throw new Error(`${id} is terminal (${current.status})`);
    }
    if (current.status === "stopped" && status === "stopped") return current;
    current.status = status;
    current.stop_reason = reason;
    await writeGoalUnlocked(current, current);
    return current;
  });
  await appendGoalEvent(id, { type: status, body: reason, task_id: goal.active_task_id });
  if (status === "stopped" && goal.active_task_id && !goal.active_task_id.startsWith("pending:")) {
    await cancelBackgroundTask(goal.active_task_id);
    await advanceGoalAfterBackgroundTask(goal.active_task_id);
    return readGoal(id);
  }
  return goal;
}

export async function resumeGoal(id: string): Promise<GoalState> {
  const goal = await withFileLock(goalPath(id), async () => {
    const current = await readGoalUnlocked(id);
    if (!["paused", "waiting_on_approval"].includes(current.status))
      throw new Error(`${id} is ${current.status}, not paused/waiting`);
    current.status = "active";
    current.stop_reason = undefined;
    await writeGoalUnlocked(current, current);
    return current;
  });
  if (goal.active_task_id) {
    await appendGoalEvent(id, {
      type: "resumed",
      body: `resumed with active task ${goal.active_task_id}`,
      task_id: goal.active_task_id,
    });
    if (!goal.active_task_id.startsWith("pending:")) {
      await launchLinkedGoalTask(id, goal.active_task_id);
    }
    return goal;
  }
  await appendGoalEvent(id, { type: "resumed", body: "resumed and starting next task" });
  return startNextGoalTask(id, "resume");
}

export async function launchLinkedGoalTask(goalId: string, taskId: string): Promise<boolean> {
  return withFileLock(goalPath(goalId), async () => {
    const goal = await readGoalUnlocked(goalId);
    if (goal.status !== "active" || goal.active_task_id !== taskId) return false;
    const child = await readBackgroundTask(taskId);
    if (child.status !== "queued" || child.pid) return false;
    if (child.launch_deferred) await activateDeferredBackgroundTask(child.id);
    await launchBackgroundTask(child.id);
    return true;
  });
}

export async function advanceGoalAfterBackgroundTask(taskId: string): Promise<GoalState | undefined> {
  const task = await readBackgroundTask(taskId);
  const goalId = task.goal_id;
  if (!goalId) return undefined;
  const result = classifyChildResult(task);
  const events: Array<Omit<GoalEvent, "ts">> = [];
  let autoContinue = false;
  let didAdvance = false;
  const goal = await withFileLock(goalPath(goalId), async () => {
    const current = await readGoalUnlocked(goalId);
    if (current.active_task_id !== taskId) return current;

    if (current.status === "stopped") {
      didAdvance = true;
      current.active_task_id = undefined;
      events.push({ type: "task_finished", task_id: taskId, body: `${taskId} finished with ${task.status}` });
      await writeGoalUnlocked(current, current);
      return current;
    }
    if (result === "blocked") {
      // Keep the child linked while it waits for /answer or /fixbg. Clearing
      // active_task_id here allowed /goal next to start a second child and
      // detached the eventual resumed result from its parent goal.
      const paused = current.status === "paused";
      const reason = paused
        ? `paused while ${taskId} requires main review (${task.status})`
        : `${taskId} requires main review (${task.status})`;
      if (current.stop_reason === reason && (paused || current.status === "waiting_on_approval")) return current;
      didAdvance = true;
      if (!paused) current.status = "waiting_on_approval";
      current.stop_reason = reason;
      events.push({ type: paused ? "paused" : "waiting_on_approval", task_id: taskId, body: reason });
      await writeGoalUnlocked(current, current);
      return current;
    }

    didAdvance = true;
    current.active_task_id = undefined;
    events.push({ type: "task_finished", task_id: taskId, body: `${taskId} finished with ${task.status}` });
    if (current.status === "paused") {
      current.stop_reason = `paused after ${taskId} finished with ${task.status}`;
      events.push({ type: "paused", task_id: taskId, body: current.stop_reason });
      await writeGoalUnlocked(current, current);
      return current;
    }

    if (result === "failed") {
      current.failures += 1;
      if (current.failures > current.budgets.max_failures) {
        current.status = "failed";
        current.stop_reason = `failure budget exhausted after ${taskId} (${current.failures}/${current.budgets.max_failures})`;
        events.push({ type: "failed", task_id: taskId, body: current.stop_reason });
        await writeGoalUnlocked(current, current);
        return current;
      }
      if (!current.budgets.auto_continue) {
        current.status = "waiting_on_approval";
        current.stop_reason = `${taskId} failed within the configured failure budget; approve another task to continue`;
        events.push({ type: "waiting_on_approval", task_id: taskId, body: current.stop_reason });
        await writeGoalUnlocked(current, current);
        return current;
      }
    }

    const allowed = canStartGoalTask(current);
    if (!allowed.ok) {
      current.status = result === "failed" ? "failed" : allowed.done ? "done" : "failed";
      current.stop_reason = allowed.reason;
      events.push({ type: current.status, body: allowed.reason, task_id: taskId });
      await writeGoalUnlocked(current, current);
      return current;
    }
    if (!current.budgets.auto_continue) {
      current.status = "waiting_on_approval";
      current.stop_reason = `task ${taskId} is ready; use /goal next ${current.id} to spend another task budget`;
      events.push({ type: "waiting_on_approval", task_id: taskId, body: current.stop_reason });
      await writeGoalUnlocked(current, current);
      return current;
    }

    current.status = "active";
    current.stop_reason = undefined;
    autoContinue = true;
    await writeGoalUnlocked(current, current);
    return current;
  });

  if (!didAdvance) return goal;
  for (const event of events) await appendGoalEvent(goal.id, event);
  if (autoContinue) return startNextGoalTask(goal.id, `auto-continue after ${taskId}`);
  return goal;
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
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderGoalList(goals: GoalState[]): string {
  if (goals.length === 0) return "No goals.";
  return goals
    .slice(0, 10)
    .map(
      (goal) =>
        `${goal.id} — ${goal.status} — ${goal.tasks_started}/${goal.budgets.max_tasks}${goal.active_task_id ? ` active:${goal.active_task_id}` : ""} — ${goal.name}`,
    )
    .join("\n");
}

const PENDING_RESERVATION_STALE_MS = 10 * 60_000;

function pendingReservationIsStale(goal: GoalState, at = Date.now()): boolean {
  if (!goal.active_task_id?.startsWith("pending:")) return false;
  const updated = Date.parse(goal.updated_at);
  return !Number.isFinite(updated) || at - updated >= PENDING_RESERVATION_STALE_MS;
}

async function reconcilePendingGoalReservation(goal: GoalState): Promise<void> {
  if (!pendingReservationIsStale(goal)) return;
  const backgroundTasks = await listBackgroundTasks();
  const orphans = backgroundTasks.filter((task) => task.goal_id === goal.id && !goal.task_ids.includes(task.id));

  if (orphans.length === 1) {
    const orphan = orphans[0];
    const linkOutcome = await withFileLock(goalPath(goal.id), async () => {
      const current = await readGoalUnlocked(goal.id);
      if (current.active_task_id !== goal.active_task_id || !pendingReservationIsStale(current)) return undefined;
      if (current.status !== "active") {
        current.active_task_id = undefined;
        current.tasks_started = Math.max(0, current.tasks_started - 1);
        await writeGoalUnlocked(current, current);
        return { linked: false as const, status: current.status };
      }
      if (!current.task_ids.includes(orphan.id)) current.task_ids.push(orphan.id);
      current.active_task_id = orphan.id;
      current.stop_reason = undefined;
      await writeGoalUnlocked(current, current);
      if (orphan.status === "queued") {
        await activateDeferredBackgroundTask(orphan.id);
        await launchBackgroundTask(orphan.id);
      }
      return { linked: true as const, status: current.status };
    });
    if (!linkOutcome) return;
    if (!linkOutcome.linked) {
      await cancelBackgroundTask(orphan.id);
      await appendGoalEvent(goal.id, {
        type:
          linkOutcome.status === "paused"
            ? "paused"
            : linkOutcome.status === "stopped"
              ? "stopped"
              : "waiting_on_approval",
        body: `Recovered orphan ${orphan.id}, but the goal is ${linkOutcome.status}; child was cancelled before launch.`,
      });
      return;
    }
    await appendGoalEvent(goal.id, {
      type: "task_started",
      task_id: orphan.id,
      body: `Recovered stale task reservation and linked orphan task ${orphan.id}.`,
    });
    if (["done", "ready_for_pr", "needs_fix", "failed", "cancelled"].includes(orphan.status)) {
      await advanceGoalAfterBackgroundTask(orphan.id);
    }
    return;
  }

  const restart = await withFileLock(goalPath(goal.id), async () => {
    const current = await readGoalUnlocked(goal.id);
    if (current.active_task_id !== goal.active_task_id || !pendingReservationIsStale(current)) return false;
    current.active_task_id = undefined;
    if (orphans.length === 0) {
      current.tasks_started = Math.max(0, current.tasks_started - 1);
      if (!["stopped", "failed", "done"].includes(current.status)) {
        current.status = "active";
        current.stop_reason = "Recovered an abandoned task reservation; no child task had been created.";
      }
    } else {
      if (!["stopped", "failed", "done"].includes(current.status)) {
        current.status = "waiting_on_approval";
        current.stop_reason = `Found ${orphans.length} orphan child tasks for one reservation; manual selection is required.`;
      }
    }
    await writeGoalUnlocked(current, current);
    return orphans.length === 0 && current.status === "active" && current.budgets.auto_continue;
  });
  await appendGoalEvent(goal.id, {
    type: orphans.length === 0 ? "resumed" : "waiting_on_approval",
    body:
      orphans.length === 0
        ? "Cleared stale task reservation; no orphan child was found."
        : `Could not safely reconcile stale reservation: ${orphans.map((task) => task.id).join(", ")}.`,
  });
  if (restart) await startNextGoalTask(goal.id, "recovered abandoned reservation");
}

async function enforceGoalDeadline(goalId: string): Promise<void> {
  const outcome = await withFileLock(goalPath(goalId), async () => {
    const goal = await readGoalUnlocked(goalId);
    const expired = Date.now() >= Date.parse(goal.deadline_at);
    if (!["done", "stopped", "failed"].includes(goal.status) && expired) {
      goal.status = "stopped";
      goal.stop_reason = "time budget exhausted; active child was stopped by the goal supervisor";
      await writeGoalUnlocked(goal, goal);
      return { changed: true, activeTaskId: goal.active_task_id };
    }
    if (goal.status === "stopped" && goal.active_task_id && !goal.active_task_id.startsWith("pending:")) {
      return { changed: false, activeTaskId: goal.active_task_id };
    }
    return { changed: false, activeTaskId: undefined };
  });

  if (outcome.changed) {
    await appendGoalEvent(goalId, { type: "stopped", body: "Goal deadline reached; autonomous work stopped." });
  }
  if (!outcome.activeTaskId || outcome.activeTaskId.startsWith("pending:")) return;
  await cancelBackgroundTask(outcome.activeTaskId).catch(() => undefined);
  await advanceGoalAfterBackgroundTask(outcome.activeTaskId).catch(() => undefined);
}

/** Startup/periodic repair for reservations, deadlines, and interrupted controllers. */
export interface ReconcileGoalsOptions {
  startInitialTask?: (goalId: string) => Promise<GoalState>;
}

export async function reconcileGoals(options: ReconcileGoalsOptions = {}): Promise<void> {
  const startInitialTask =
    options.startInitialTask ?? ((goalId: string) => startNextGoalTask(goalId, "startup recovery"));
  const goals = await listGoals();
  for (const snapshot of goals) {
    try {
      await enforceGoalDeadline(snapshot.id);
      await reconcilePendingGoalReservation(snapshot);
      let current = await readGoal(snapshot.id);
      if (
        current.initial_task_pending &&
        current.status === "active" &&
        current.tasks_started === 0 &&
        !current.active_task_id
      ) {
        await startInitialTask(current.id);
        current = await readGoal(current.id);
      }
      const activeTaskId = current.active_task_id;
      if (activeTaskId && !activeTaskId.startsWith("pending:")) {
        const task = await readBackgroundTask(activeTaskId).catch(() => undefined);
        if (task && current.status === "active" && task.status === "queued" && !task.pid) {
          await launchLinkedGoalTask(current.id, task.id);
        }
        if (
          task &&
          ["done", "ready_for_pr", "needs_fix", "failed", "cancelled", "waiting_on_main"].includes(task.status)
        ) {
          await advanceGoalAfterBackgroundTask(task.id);
        }
      }
    } catch (err) {
      await appendGoalEvent(snapshot.id, {
        type: "waiting_on_approval",
        body: `Goal reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => undefined);
    }
  }
}

export function renderGoalEvents(events: GoalEvent[]): string {
  if (events.length === 0) return "No goal events.";
  return events
    .map((event) => `- ${event.ts} ${event.type}${event.task_id ? `/${event.task_id}` : ""}: ${event.body}`)
    .join("\n");
}

function budgetLabel(goal: GoalState): string {
  return `tasks ${goal.budgets.max_tasks}, minutes ${goal.budgets.max_minutes}, failures ${goal.budgets.max_failures}, auto ${goal.budgets.auto_continue ? "on" : "off"}`;
}
