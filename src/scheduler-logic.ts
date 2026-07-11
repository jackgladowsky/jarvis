import { createHash } from "node:crypto";
import type { Config } from "./config-schema.js";

export type RecurringTask = Config["scheduler"]["tasks"][number] & {
  timezone?: string;
  status?: "active" | "cancelled";
  revision?: number;
  idempotency_key?: string;
  request_fingerprint?: string;
  last_mutation_key?: string;
};
export type OneTimeTask = {
  id: string;
  name: string;
  run_at: string;
  prompt: string;
  notify: "always" | "on_issue" | "never";
  provider?: "codex" | "anthropic" | "openrouter";
  model?: string;
  timezone?: string;
  revision?: number;
  idempotency_key?: string;
  request_fingerprint?: string;
  last_mutation_key?: string;
  /** Durable execution state. Missing means pending for backwards compatibility. */
  status?: "pending" | "running" | "retry_wait" | "completed" | "failed" | "cancelled";
  attempts?: number;
  max_attempts?: number;
  execution_id?: string;
  next_attempt_at?: string;
  last_attempt_at?: string;
  completed_at?: string;
  last_error?: string;
  notification_id?: string;
  notification_title?: string;
  notification_body?: string;
  notification_enqueued_at?: string;
};
export type SchedulerJob = RecurringTask | OneTimeTask;
export type DynamicTask = RecurringTask | OneTimeTask;

export function isOneTimeTask(task: SchedulerJob): task is OneTimeTask {
  return "run_at" in task;
}

export function taskSignature(task: SchedulerJob): string {
  return JSON.stringify(
    isOneTimeTask(task)
      ? {
          name: task.name,
          run_at: task.run_at,
          prompt: task.prompt,
          notify: task.notify,
          provider: task.provider,
          model: task.model,
          timezone: task.timezone,
          status: task.status ?? "pending",
          attempts: task.attempts ?? 0,
          next_attempt_at: task.next_attempt_at,
        }
      : {
          name: task.name,
          schedule: task.schedule,
          prompt: task.prompt,
          notify: task.notify,
          provider: task.provider,
          model: task.model,
          timezone: task.timezone,
          status: task.status ?? "active",
        },
  );
}

export function oneTimeTaskStatus(task: OneTimeTask): NonNullable<OneTimeTask["status"]> {
  return task.status ?? "pending";
}

export function oneTimeTaskRunAt(task: OneTimeTask): number {
  return Date.parse(task.next_attempt_at ?? task.run_at);
}

export function schedulerRetryDelayMs(attempts: number): number {
  const sequence = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
  return sequence[Math.min(sequence.length - 1, Math.max(0, attempts - 1))];
}

/** Collision-resistant, readable identity for one durable scheduler event. */
export function schedulerNotificationId(task: OneTimeTask): string {
  const taskDigest = createHash("sha256").update(task.id).digest("hex").slice(0, 12);
  const taskPrefix = task.id.slice(0, 12);
  const parsedRunAt = Date.parse(task.run_at);
  const runKey = (Number.isFinite(parsedRunAt) ? Math.max(0, parsedRunAt) : 0).toString(36);
  return `sched-${taskPrefix}-${taskDigest}-${runKey}-${task.attempts ?? 0}`;
}

export function oneTimeResultState(
  task: OneTimeTask,
  success: boolean,
  error: string | undefined,
  retryAllowed: boolean,
  nowMs = Date.now(),
  notification?: { id: string; title: string; body: string },
): OneTimeTask {
  const notificationState = notification
    ? {
        notification_id: notification.id,
        notification_title: notification.title,
        notification_body: notification.body,
        notification_enqueued_at: undefined,
      }
    : {
        notification_id: undefined,
        notification_title: undefined,
        notification_body: undefined,
        notification_enqueued_at: undefined,
      };
  const completedAt = new Date(nowMs).toISOString();
  if (success) {
    return {
      ...task,
      status: "completed",
      completed_at: completedAt,
      next_attempt_at: undefined,
      last_error: undefined,
      ...notificationState,
    };
  }
  const attempts = task.attempts ?? 1;
  const maxAttempts = task.max_attempts ?? 4;
  if (!retryAllowed || attempts >= maxAttempts) {
    return {
      ...task,
      status: "failed",
      completed_at: completedAt,
      next_attempt_at: undefined,
      last_error: error,
      ...notificationState,
    };
  }
  return {
    ...task,
    status: "retry_wait",
    next_attempt_at: new Date(nowMs + schedulerRetryDelayMs(attempts)).toISOString(),
    last_error: error,
    ...notificationState,
  };
}

export function shouldNotify(task: SchedulerJob, success: boolean, output: string): boolean {
  if (task.notify === "never") return false;
  if (task.notify === "always") return true;
  if (!success) return true;

  const explicit = output.match(/^\s*NOTIFY:\s*(yes|no)\s*(?:\r?\n|$)/i);
  if (explicit) return explicit[1].toLowerCase() === "yes";

  return /^\s*(?:warning|error|critical|alert|failure)(?:\s*:|\b)/im.test(output);
}
