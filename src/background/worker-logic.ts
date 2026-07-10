import type { BackgroundTask } from "./types.js";

export function parseReviewVerdict(output: string): "ready" | "needs_fix" {
  const firstNonemptyLine =
    output
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  const match = firstNonemptyLine.match(/^VERDICT:\s*(ready|needs_fix)$/i);
  return match?.[1].toLowerCase() === "ready" ? "ready" : "needs_fix";
}

export function stageMustHalt(task: Pick<BackgroundTask, "status">): boolean {
  return task.status === "waiting_on_main" || task.status === "cancelled";
}

/**
 * Identify one durable lifecycle transition. Recovery reuses the ID persisted
 * with the state change; a later transition to the same status gets the next
 * task revision. Keep the generation near the front so queue ID truncation
 * cannot discard the part that differentiates repeated events.
 */
export function backgroundLifecycleNotificationId(
  task: Pick<BackgroundTask, "id" | "revision">,
  event: string,
): string {
  const generation = ((task.revision ?? 0) + 1).toString(36);
  return `bg-${generation}-${task.id}-${event}`;
}

export function parseWorkerOutcome(output: string): "completed" | "blocked" | "invalid" {
  const finalNonemptyLine = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const match = finalNonemptyLine?.match(/^OUTCOME:\s*(completed|blocked)$/i);
  if (!match) return "invalid";
  return match[1].toLowerCase() === "completed" ? "completed" : "blocked";
}
