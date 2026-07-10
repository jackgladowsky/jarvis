import test from "node:test";
import assert from "node:assert/strict";
import { preparationShouldWait, terminalNotificationNeedsEnqueue, workerRecoveryDecision } from "./supervisor-logic.js";
import type { BackgroundTask } from "./types.js";

function task(status: BackgroundTask["status"], pid?: number): BackgroundTask {
  return {
    id: "fern-sparrow",
    uuid: "uuid",
    name: "test",
    status,
    prompt: "test",
    repo: "/repo",
    worktree: "/worktree",
    branch: "worker/test",
    chat_id: 1,
    pipeline: [{ role: "implementer", status: "queued" }],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pid,
  };
}

test("worker recovery decisions preserve live work and resume stale work", () => {
  assert.equal(workerRecoveryDecision(task("implementing", 10), true), "none");
  assert.equal(workerRecoveryDecision(task("implementing", 10), false), "quarantine");
  assert.equal(workerRecoveryDecision(task("queued"), false), "launch");
  assert.equal(workerRecoveryDecision(task("waiting_on_main", 10), false), "clear_pid");
  assert.equal(workerRecoveryDecision(task("done", 10), false), "clear_pid");
  assert.equal(workerRecoveryDecision(task("done"), false), "none");
});

test("terminal outbox reconciliation stops after durable enqueue acknowledgement", () => {
  const terminal = task("done");
  terminal.terminal_notification_id = "background-terminal-fern-sparrow-done";
  assert.equal(terminalNotificationNeedsEnqueue(terminal), true);
  terminal.terminal_notification_enqueued_at = "2026-01-01T00:00:00.000Z";
  assert.equal(terminalNotificationNeedsEnqueue(terminal), false);
});

test("an old preparation lease is never reclaimed while its owner is alive", () => {
  const preparing = task("queued");
  preparing.preparing = true;
  preparing.preparing_pid = 123;
  preparing.preparing_pid_start_time = "555";
  preparing.preparing_started_at = "2000-01-01T00:00:00.000Z";
  assert.equal(preparationShouldWait(preparing, true, "555"), true);
  assert.equal(preparationShouldWait(preparing, true, "999"), process.platform !== "linux");
  assert.equal(preparationShouldWait(preparing, false, "555"), false);
});
