export type BackgroundTaskStatus =
  "queued" | "running" | "waiting_on_main" | "ready_for_pr" | "failed" | "cancelled" | "done";

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
  /** Commit from which the isolated worker branch was created. */
  base_sha?: string;
  chat_id: number;
  /** Optional parent autonomous goal id; used only for traceability/advancement. */
  goal_id?: string;
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
  error?: string;
  /** Deterministic outbox id written in the same commit as terminal/attention state. */
  terminal_notification_id?: string;
  /** Controller acknowledged that the deterministic notification is durably queued/archived. */
  terminal_notification_enqueued_at?: string;
  /** Durable lifecycle outbox. */
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

export type BackgroundMailType = "question" | "answer" | "status" | "handoff" | "error";

export interface BackgroundMailEntry {
  ts: string;
  from: "main" | "worker";
  type: BackgroundMailType;
  body: string;
}
