import { execFile } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  appendBackgroundMail,
  cancelBackgroundTask,
  launchBackgroundTask,
  listBackgroundTasks,
  readBackgroundTask,
  writeBackgroundTask,
} from "./manager.js";
import type { BackgroundTask } from "./types.js";
import { log } from "../lib/logger.js";
import { preparationShouldWait, terminalNotificationNeedsEnqueue, workerRecoveryDecision } from "./supervisor-logic.js";
import { paths } from "../paths.js";
import { launchLinkedGoalTask, readGoal, reconcileGoals } from "../goals/manager.js";
import { notifyMainOrFallback } from "../lib/internal-notifications.js";
import { readProcessStartTime } from "../lib/process-identity.js";
import { backgroundLifecycleNotificationId } from "./worker-logic.js";

const SUPERVISOR_INTERVAL_MS = 30_000;
const TERMINAL_TASK_STATUSES = new Set(["needs_fix", "ready_for_pr", "failed", "cancelled", "done"]);
const execFileAsync = promisify(execFile);
async function isOwnedWorkerAlive(pid: number | undefined, taskId: string): Promise<boolean> {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  let commandLine: string;
  try {
    commandLine = await readFile(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    return false;
  }
  const args = commandLine.split("\0").filter(Boolean);
  return (
    args.includes(taskId) &&
    args.some((arg) => arg.endsWith("run-background-worker.sh") || /(?:^|\/)background\/worker\.js$/.test(arg))
  );
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function worktreeIsValid(task: BackgroundTask): Promise<boolean> {
  try {
    if (!(await stat(task.worktree)).isDirectory()) return false;
    const { stdout } = await execFileAsync("git", ["-C", task.worktree, "rev-parse", "--is-inside-work-tree"], {
      timeout: 5_000,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function markUnrecoverable(task: BackgroundTask, message: string): Promise<void> {
  task.status = "failed";
  task.pid = undefined;
  task.current_role = undefined;
  task.finished_at = new Date().toISOString();
  task.error = message;
  task.terminal_notification_id = backgroundLifecycleNotificationId(task, "terminal-failed");
  task.terminal_notification_enqueued_at = undefined;
  const running = task.pipeline.find((stage) => stage.status === "running");
  if (running) {
    running.status = "failed";
    running.finished_at = task.finished_at;
    running.error = message;
  }
  await writeBackgroundTask(task);
  await appendBackgroundMail(task.id, { from: "main", type: "error", body: message }).catch(() => undefined);
}

async function quarantineInterruptedTask(task: BackgroundTask): Promise<void> {
  const message =
    "Worker process disappeared during an active stage. Its side-effect outcome is unknown, so JARVIS did not replay it automatically. Inspect the worktree/task note, then answer or explicitly resume the task.";
  task.status = "waiting_on_main";
  task.pid = undefined;
  task.error = message;
  task.terminal_notification_id = `background-interrupted-${task.id}-${(task.revision ?? 0) + 1}`;
  task.terminal_notification_enqueued_at = undefined;
  const running = task.pipeline.find((stage) => stage.status === "running");
  if (running) {
    running.status = "failed";
    running.finished_at = new Date().toISOString();
    running.error = message;
    task.current_role = running.role;
  }
  await writeBackgroundTask(task);
  await appendBackgroundMail(task.id, { from: "worker", type: "question", body: message }).catch(() => undefined);
  await notifyMainOrFallback({
    id: task.terminal_notification_id,
    source: "background",
    chat_id: task.chat_id,
    title: `${task.id} needs recovery review`,
    body: message,
    fallback_text: `Background task ${task.id} stopped unexpectedly. ${message}`,
  }).catch((err) =>
    log.warn("interrupted background task notification failed", {
      id: task.id,
      err: err instanceof Error ? err.message : err,
    }),
  );
}

async function reconcileTaskOutbox(task: BackgroundTask): Promise<BackgroundTask> {
  if (!terminalNotificationNeedsEnqueue(task)) return task;
  const body = task.error
    ? `Background task ${task.id} ${task.status}: ${task.error}`
    : (task.summary ?? `Background task ${task.id} is ${task.status}.`).slice(0, 2500);
  await notifyMainOrFallback({
    id: task.terminal_notification_id!,
    source: "background",
    chat_id: task.chat_id,
    title: `${task.id} ${task.status}`,
    body,
    fallback_text: body,
  });
  const current = await readBackgroundTask(task.id);
  if (
    current.terminal_notification_id === task.terminal_notification_id &&
    !current.terminal_notification_enqueued_at
  ) {
    current.terminal_notification_enqueued_at = new Date().toISOString();
    await writeBackgroundTask(current);
  }
  return current;
}

async function reconcileTask(taskId: string): Promise<void> {
  let task = await readBackgroundTask(taskId);
  if (task.preparing) {
    const ownerAlive = processIsAlive(task.preparing_pid);
    const observedStartTime = task.preparing_pid ? await readProcessStartTime(task.preparing_pid) : undefined;
    if (preparationShouldWait(task, ownerAlive, observedStartTime)) return;
    if (!(await worktreeIsValid(task))) {
      await markUnrecoverable(task, "background task preparation was interrupted before its worktree was created");
      return;
    }
    task.preparing = undefined;
    task.preparing_pid = undefined;
    task.preparing_pid_start_time = undefined;
    task.preparing_started_at = undefined;
    task.launch_deferred = task.goal_id ? true : undefined;
    await writeBackgroundTask(task);
    await appendBackgroundMail(task.id, {
      from: "main",
      type: "status",
      body: "Recovered an interrupted task preparation from its existing worktree.",
    }).catch(() => undefined);
  }
  task = await reconcileTaskOutbox(task);
  if (task.launch_deferred) return;
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    if (task.pid !== undefined) {
      task.pid = undefined;
      await writeBackgroundTask(task);
    }
    return;
  }
  if (task.goal_id) {
    const goal = await readGoal(task.goal_id).catch(() => undefined);
    if (goal && goal.status !== "active") {
      // A paused/stopped goal owns its child lifecycle. Do not let the generic
      // capacity queue silently restart autonomous work behind that boundary.
      if (["stopped", "failed", "done"].includes(goal.status) && !TERMINAL_TASK_STATUSES.has(task.status)) {
        await cancelBackgroundTask(task.id);
      } else if (task.pid !== undefined && !(await isOwnedWorkerAlive(task.pid, task.id))) {
        task.pid = undefined;
        await writeBackgroundTask(task);
      }
      return;
    }
  }
  const ownedWorkerAlive = await isOwnedWorkerAlive(task.pid, task.id);
  const failurePath = join(paths.background, "bootstrap-failures", `${task.id}.json`);
  let bootstrapFailure: string | undefined;
  if (!ownedWorkerAlive) {
    try {
      const failure = JSON.parse(await readFile(failurePath, "utf-8")) as { error?: string };
      bootstrapFailure = failure.error ?? "background worker bootstrap failed";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("background bootstrap failure marker could not be reconciled", {
          id: task.id,
          err: err instanceof Error ? err.message : err,
        });
      }
    }
  }
  if (bootstrapFailure) {
    await markUnrecoverable(task, bootstrapFailure);
    await rm(failurePath, { force: true });
    return;
  }
  const decision = workerRecoveryDecision(task, ownedWorkerAlive);
  if (decision === "none") return;

  if (decision === "clear_pid") {
    task.pid = undefined;
    await writeBackgroundTask(task);
    return;
  }

  if (decision === "quarantine") {
    await quarantineInterruptedTask(task);
    return;
  }

  if (!(await worktreeIsValid(task))) {
    await markUnrecoverable(task, `background task recovery failed: worktree is missing (${task.worktree})`);
    return;
  }

  if (task.pid !== undefined) {
    // A numeric PID that is dead or belongs to another process is not proof
    // of a live worker. Clear it before the manager's guarded launch.
    task.pid = undefined;
    await writeBackgroundTask(task);
  }

  try {
    if (task.goal_id && !(await launchLinkedGoalTask(task.goal_id, task.id))) return;
    const launched = task.goal_id ? await readBackgroundTask(task.id) : await launchBackgroundTask(task.id);
    log.info("background supervisor reconciled task", {
      id: task.id,
      role: launched.current_role,
      pid: launched.pid,
      queuedForCapacity: !launched.pid,
    });
  } catch (err) {
    const current = await readBackgroundTask(task.id).catch(() => undefined);
    if (current?.pid || current?.status !== "queued") return;
    throw err;
  }
}

export async function reconcileBackgroundWorkers(): Promise<void> {
  const tasks = await listBackgroundTasks();
  for (const task of tasks) {
    await reconcileTask(task.id).catch((err) =>
      log.warn("background worker reconciliation failed", {
        id: task.id,
        err: err instanceof Error ? err.message : err,
      }),
    );
  }
}

export async function startBackgroundWorkerSupervisor(): Promise<() => void> {
  let stopped = false;
  let active = false;
  const run = async (): Promise<void> => {
    if (stopped || active) return;
    active = true;
    try {
      await reconcileGoals().catch((err) =>
        log.warn("goal reconciliation cycle failed", { err: err instanceof Error ? err.message : err }),
      );
      await reconcileBackgroundWorkers().catch((err) =>
        log.warn("background reconciliation cycle failed", { err: err instanceof Error ? err.message : err }),
      );
    } finally {
      active = false;
    }
  };

  await run();
  const timer = setInterval(() => void run(), SUPERVISOR_INTERVAL_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
