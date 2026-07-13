export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "researching"
  | "implementing"
  | "reviewing"
  | "waiting_on_main"
  | "awaiting_review"
  | "needs_fix"
  | "ready_for_pr"
  | "failed"
  | "cancelled"
  | "done";

export type BackgroundRole = "planner" | "researcher" | "implementer" | "reviewer" | "fixer";
export type BackgroundStageStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface BackgroundStage {
  role: BackgroundRole;
  status: BackgroundStageStatus;
  started_at?: string;
  finished_at?: string;
  summary?: string;
  error?: string;
  /** Model route selected for this stage, when one was explicitly configured. */
  model_provider?: string;
  model_id?: string;
}

export interface BackgroundTask {
  /** Human-friendly handle used in chat commands, e.g. `moss-otter`. */
  id: string;
  /** Stable globally-unique id for logs/future migrations. */
  uuid: string;
  name: string;
  status: BackgroundTaskStatus;
  prompt: string;
  repo: string;
  worktree: string;
  branch: string;
  chat_id: number;
  pipeline: BackgroundStage[];
  /** Optional parent autonomous goal id; used only for traceability/advancement. */
  goal_id?: string;
  /** Ensures review-triggered remediation runs at most once automatically. */
  automatic_fix_attempted?: boolean;
  current_role?: BackgroundRole;
  /** Goal controller has created this task but has not durably linked it yet. */
  launch_deferred?: boolean;
  /** Durable task-creation lease, reconciled if the creating process dies. */
  preparing?: boolean;
  preparing_pid?: number;
  preparing_pid_start_time?: string;
  preparing_started_at?: string;
  pid?: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  summary?: string;
  review_summary?: string;
  error?: string;
  /** Deterministic outbox id written in the same commit as terminal/attention state. */
  terminal_notification_id?: string;
  /** Controller acknowledged that the deterministic notification is durably queued/archived. */
  terminal_notification_enqueued_at?: string;
  /**
   * Durable lifecycle outbox. Unlike the legacy terminal slot, this can retain
   * a reviewer rejection while the automatic fixer advances the task.
   */
  lifecycle_notifications?: Array<{
    id: string;
    event: string;
    title: string;
    body: string;
    fallback_text: string;
    enqueued_at?: string;
  }>;
  /** Monotonic compare-and-swap revision for cross-process state updates. */
  revision?: number;
}

export type BackgroundMailType = "question" | "answer" | "status" | "decision" | "handoff" | "error" | "review";

export interface BackgroundMailEntry {
  ts: string;
  from: "main" | "worker";
  type: BackgroundMailType;
  body: string;
}
