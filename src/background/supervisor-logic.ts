import type { BackgroundTask } from "./types.js";

const TERMINAL_STATUSES = new Set(["needs_fix", "ready_for_pr", "failed", "cancelled", "done"]);
const ACTIVE_STATUSES = new Set(["running", "researching", "implementing", "reviewing", "awaiting_review"]);

export type WorkerRecoveryDecision = "none" | "clear_pid" | "launch" | "quarantine";

export function workerRecoveryDecision(task: BackgroundTask, ownedWorkerAlive: boolean): WorkerRecoveryDecision {
  if (TERMINAL_STATUSES.has(task.status) || task.status === "waiting_on_main") {
    return task.pid === undefined ? "none" : "clear_pid";
  }
  if (ownedWorkerAlive) return "none";
  if (task.status === "queued") return "launch";
  if (ACTIVE_STATUSES.has(task.status)) return "quarantine";
  return task.pid === undefined ? "none" : "clear_pid";
}

export function terminalNotificationNeedsEnqueue(task: BackgroundTask): boolean {
  return Boolean(task.terminal_notification_id && !task.terminal_notification_enqueued_at);
}

export function preparationShouldWait(
  task: BackgroundTask,
  ownerAlive: boolean,
  observedStartTime: string | undefined,
): boolean {
  if (!task.preparing || !ownerAlive) return false;
  if (process.platform !== "linux") return true;
  return Boolean(
    task.preparing_pid_start_time && observedStartTime && task.preparing_pid_start_time === observedStartTime,
  );
}
