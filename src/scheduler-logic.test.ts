import test from "node:test";
import assert from "node:assert/strict";
import { isOneTimeTask, shouldNotify, taskSignature, type SchedulerJob } from "./scheduler-logic.js";

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
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "NOTIFY: no\nNo issues."), false);
  assert.equal(shouldNotify({ ...recurring, notify: "on_issue" }, true, "NOTIFY: yes\nAll clear."), true);
});
