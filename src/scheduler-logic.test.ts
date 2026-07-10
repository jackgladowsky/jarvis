import test from "node:test";
import assert from "node:assert/strict";
import {
  isOneTimeTask,
  oneTimeTaskRunAt,
  oneTimeTaskStatus,
  oneTimeResultState,
  schedulerNotificationId,
  schedulerRetryDelayMs,
  shouldNotify,
  taskSignature,
  type SchedulerJob,
} from "./scheduler-logic.js";

const recurring: SchedulerJob = {
  id: "daily",
  name: "Daily",
  schedule: "0 9 * * *",
  prompt: "Check things",
  notify: "on_issue",
};

const oneTime: SchedulerJob = {
  id: "reminder",
  name: "Reminder",
  run_at: "2030-01-01T00:00:00.000Z",
  prompt: "Remind me",
  notify: "always",
};

test("isOneTimeTask distinguishes dynamic reminders from recurring cron jobs", () => {
  assert.equal(isOneTimeTask(recurring), false);
  assert.equal(isOneTimeTask(oneTime), true);
});

test("one-time failures retry only when the runtime declares replay safe", () => {
  const running = { ...oneTime, status: "running" as const, attempts: 1, max_attempts: 4 };
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const safe = oneTimeResultState(running, false, "transient", true, now);
  assert.equal(safe.status, "retry_wait");
  assert.equal(safe.next_attempt_at, "2030-01-01T00:01:00.000Z");

  const unsafe = oneTimeResultState(running, false, "tool may have run", false, now);
  assert.equal(unsafe.status, "failed");
  assert.equal(unsafe.next_attempt_at, undefined);
  assert.equal(unsafe.last_error, "tool may have run");
});

test("one-time result commits its notification intent with execution state", () => {
  const running = { ...oneTime, status: "running" as const, attempts: 1, max_attempts: 4 };
  const result = oneTimeResultState(running, true, undefined, false, Date.parse(oneTime.run_at), {
    id: "sched-reminder-test-1",
    title: "Reminder",
    body: "Reminder completed",
  });
  assert.equal(result.status, "completed");
  assert.equal(result.notification_id, "sched-reminder-test-1");
  assert.equal(result.notification_title, "Reminder");
  assert.equal(result.notification_body, "Reminder completed");
  assert.equal(result.notification_enqueued_at, undefined);
});

test("scheduler notification IDs distinguish task IDs with the same prefix", () => {
  const first = schedulerNotificationId({ ...oneTime, id: "abcdefghijkl-one", attempts: 1 });
  const second = schedulerNotificationId({ ...oneTime, id: "abcdefghijkl-two", attempts: 1 });
  assert.notEqual(first, second);
  assert.equal(first, schedulerNotificationId({ ...oneTime, id: "abcdefghijkl-one", attempts: 1 }));
});

test("taskSignature ignores id and includes scheduling fields", () => {
  assert.equal(taskSignature({ ...recurring, id: "renamed" }), taskSignature(recurring));
  assert.notEqual(taskSignature({ ...recurring, schedule: "5 9 * * *" }), taskSignature(recurring));
  assert.notEqual(
    taskSignature({ ...recurring, provider: "openrouter", model: "google/gemini-2.5-flash" }),
    taskSignature(recurring),
  );
  assert.match(taskSignature(oneTime), /run_at/);
});

test("shouldNotify honors policy and issue keywords deterministically", () => {
  assert.equal(shouldNotify({ ...recurring, notify: "never" }, false, "critical failure"), false);
  assert.equal(shouldNotify({ ...recurring, notify: "always" }, true, "all clear"), true);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, false, "all clear"), true);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "warning: disk is down"), true);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "all clear"), false);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "No issues. Download complete."), false);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "NOTIFY: no\nNo issues."), false);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "NOTIFY: yes\nAll clear."), true);
});

test("one-time execution helpers preserve legacy tasks and bound backoff", () => {
  assert.equal(oneTimeTaskStatus(oneTime), "pending");
  assert.equal(oneTimeTaskRunAt(oneTime), Date.parse(oneTime.run_at));
  assert.equal(
    oneTimeTaskRunAt({ ...oneTime, status: "retry_wait", next_attempt_at: "2031-01-01T00:00:00Z" }),
    Date.parse("2031-01-01T00:00:00Z"),
  );
  assert.equal(schedulerRetryDelayMs(1), 60_000);
  assert.equal(schedulerRetryDelayMs(2), 5 * 60_000);
  assert.equal(schedulerRetryDelayMs(99), 2 * 60 * 60_000);
});
