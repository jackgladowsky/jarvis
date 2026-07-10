export type GoalStatus = "active" | "paused" | "waiting_on_approval" | "done" | "stopped" | "failed";

export interface GoalBudgets {
  max_tasks: number;
  max_minutes: number;
  max_failures: number;
  auto_continue: boolean;
}

export interface GoalState {
  id: string;
  uuid: string;
  name: string;
  objective: string;
  chat_id: number;
  status: GoalStatus;
  budgets: GoalBudgets;
  tasks_started: number;
  failures: number;
  task_ids: string[];
  active_task_id?: string;
  /** Durable startup intent cleared when the first task budget is reserved. */
  initial_task_pending?: boolean;
  stop_reason?: string;
  created_at: string;
  updated_at: string;
  deadline_at: string;
  /** Monotonic compare-and-swap revision for cross-process state updates. */
  revision?: number;
}

export type GoalEventType =
  | "created"
  | "task_started"
  | "task_finished"
  | "paused"
  | "resumed"
  | "stopped"
  | "done"
  | "failed"
  | "waiting_on_approval";

export interface GoalEvent {
  ts: string;
  type: GoalEventType;
  body: string;
  task_id?: string;
}

export interface GoalStartOptions {
  maxTasks?: number;
  maxMinutes?: number;
  maxFailures?: number;
  autoContinue?: boolean;
}
