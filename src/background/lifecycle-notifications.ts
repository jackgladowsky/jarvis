import { notifyMainOrFallback } from "../lib/internal-notifications.js";
import { readBackgroundTask, writeBackgroundTask } from "./manager.js";
import type { BackgroundTask } from "./types.js";
import { backgroundLifecycleNotificationId } from "./worker-logic.js";

export interface BackgroundLifecycleNotificationRecord {
  id: string;
  event: string;
  title: string;
  body: string;
  fallback_text: string;
  enqueued_at?: string;
}

/**
 * Add a lifecycle event to the task's durable outbox before the caller writes
 * its state transition. The revision-derived ID makes retries idempotent while
 * allowing a later transition of the same kind to notify again.
 */
export function queueBackgroundLifecycleNotification(
  task: BackgroundTask,
  event: string,
  title: string,
  body: string,
): BackgroundLifecycleNotificationRecord {
  const id = backgroundLifecycleNotificationId(task, event);
  const existing = task.lifecycle_notifications?.find((notification) => notification.id === id);
  if (existing) return existing;
  const notification: BackgroundLifecycleNotificationRecord = {
    id,
    event,
    title,
    body,
    fallback_text: body,
  };
  task.lifecycle_notifications = [...(task.lifecycle_notifications ?? []), notification];
  return notification;
}

export function queueReviewerNeedsFix(task: BackgroundTask): BackgroundLifecycleNotificationRecord {
  return queueBackgroundLifecycleNotification(
    task,
    "review-needs-fix",
    `${task.id} review needs fixes`,
    `Background task ${task.id} was rejected by review. One automatic fixer + final review cycle is queued. Next action: JARVIS will retry once; inspect /task ${task.id} for the review, or use /fixbg ${task.id} if it still needs fixes.`,
  );
}

/** Queue the owner-facing message for a durable task status transition. */
export function queueBackgroundStatusNotification(
  task: BackgroundTask,
): BackgroundLifecycleNotificationRecord | undefined {
  const detail = (task.error ?? task.review_summary ?? task.summary ?? "").slice(0, 2_000);
  const withDetail = (text: string): string => (detail ? `${text}\n\n${detail}` : text);
  switch (task.status) {
    case "waiting_on_main":
      return queueBackgroundLifecycleNotification(
        task,
        "waiting-on-main",
        `${task.id} is waiting for input`,
        withDetail(`Background task ${task.id} needs your input. Next action: /answer ${task.id} <response>.`),
      );
    case "needs_fix":
      return queueBackgroundLifecycleNotification(
        task,
        "terminal-needs-fix",
        `${task.id} needs fixes`,
        withDetail(
          `Background task ${task.id} did not pass review. Next action: inspect /task ${task.id}, then run /fixbg ${task.id}.`,
        ),
      );
    case "ready_for_pr":
      return queueBackgroundLifecycleNotification(
        task,
        "terminal-ready-for-pr",
        `${task.id} is ready for PR`,
        withDetail(`Background task ${task.id} passed review. Next action: inspect the worktree and prepare the PR.`),
      );
    case "failed":
      return queueBackgroundLifecycleNotification(
        task,
        "terminal-failed",
        `${task.id} failed`,
        withDetail(
          `Background task ${task.id} failed. Next action: inspect /task ${task.id}, then resume with /fixbg ${task.id} if appropriate.`,
        ),
      );
    case "done":
      return queueBackgroundLifecycleNotification(
        task,
        "terminal-done",
        `${task.id} completed`,
        withDetail(`Background task ${task.id} completed. Next action: inspect the worktree and handoff summary.`),
      );
    default:
      return undefined;
  }
}

export function lifecycleNotificationsNeedingEnqueue(task: BackgroundTask): BackgroundLifecycleNotificationRecord[] {
  return (task.lifecycle_notifications ?? []).filter((notification) => !notification.enqueued_at);
}

/**
 * Queue every unacknowledged lifecycle event through the existing durable
 * internal-notification pump. Acknowledgement is a separate task write, so a
 * crash between the two is safe: the deterministic queue ID deduplicates the
 * replay on restart.
 */
export async function enqueueBackgroundLifecycleNotifications(taskId: string): Promise<void> {
  const task = await readBackgroundTask(taskId);
  for (const notification of lifecycleNotificationsNeedingEnqueue(task)) {
    await notifyMainOrFallback({
      id: notification.id,
      source: "background",
      chat_id: task.chat_id,
      title: notification.title,
      body: notification.body,
      fallback_text: notification.fallback_text,
    });

    const current = await readBackgroundTask(taskId);
    const currentNotification = current.lifecycle_notifications?.find((candidate) => candidate.id === notification.id);
    if (!currentNotification?.enqueued_at) {
      currentNotification!.enqueued_at = new Date().toISOString();
      await writeBackgroundTask(current);
    }
  }
}
