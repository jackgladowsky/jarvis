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

export type BackgroundRole = "researcher" | "implementer" | "reviewer" | "fixer";
export type BackgroundStageStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface BackgroundStage {
  role: BackgroundRole;
  status: BackgroundStageStatus;
  started_at?: string;
  finished_at?: string;
  summary?: string;
  error?: string;
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
  current_role?: BackgroundRole;
  pid?: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  summary?: string;
  review_summary?: string;
  error?: string;
}

export type BackgroundMailType = "question" | "answer" | "status" | "decision" | "handoff" | "error" | "review";

export interface BackgroundMailEntry {
  ts: string;
  from: "main" | "worker";
  type: BackgroundMailType;
  body: string;
}
