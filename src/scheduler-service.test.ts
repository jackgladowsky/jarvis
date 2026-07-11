import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { atomicWriteJson } from "./lib/durable-file.js";
import { paths } from "./paths.js";
import {
  cancelDynamicTask,
  createDynamicTask,
  listDynamicTasks,
  parseNaturalRunAt,
  parseRecurringSchedule,
  readDynamicTaskFile,
  setSchedulerReconciler,
  snoozeDynamicTask,
  updateDynamicTask,
} from "./scheduler-service.js";

const now = new Date("2026-03-06T17:00:00.000Z");
test("natural one-time grammar is deterministic and timezone aware", () => {
  assert.equal(parseNaturalRunAt("2026-05-11T14:30:00-04:00", "America/New_York", now), "2026-05-11T18:30:00.000Z");
  assert.equal(parseNaturalRunAt("in 15 minutes", "UTC", now), "2026-03-06T17:15:00.000Z");
  assert.equal(parseNaturalRunAt("tomorrow at 09:30", "America/New_York", now), "2026-03-07T14:30:00.000Z");
  assert.equal(parseNaturalRunAt("monday at 08:00", "America/New_York", now), "2026-03-09T12:00:00.000Z");
  assert.throws(() => parseNaturalRunAt("sometime tomorrow", "UTC", now), /Unsupported or ambiguous/);
  assert.throws(() => parseNaturalRunAt("2026-05-11T14:30:00", "UTC", now), /explicit UTC offset/);
});

test("DST gaps and folds are rejected instead of guessed", () => {
  assert.throws(
    () => parseNaturalRunAt("tomorrow at 02:30", "America/New_York", new Date("2026-03-07T17:00:00Z")),
    /does not exist/,
  );
  assert.throws(
    () => parseNaturalRunAt("tomorrow at 01:30", "America/New_York", new Date("2026-10-31T16:00:00Z")),
    /ambiguous/,
  );
});

test("recurring phrase grammar produces validated cron", () => {
  assert.equal(parseRecurringSchedule("daily at 09:15"), "15 9 * * *");
  assert.equal(parseRecurringSchedule("every weekday at 8:30"), "30 8 * * 1-5");
  assert.equal(parseRecurringSchedule("every monday at 07:00"), "0 7 * * 1");
  assert.equal(parseRecurringSchedule("every 10 minutes"), "*/10 * * * *");
  assert.equal(parseRecurringSchedule("0 3 * * *"), "0 3 * * *");
  assert.throws(() => parseRecurringSchedule("every so often"), /Unsupported recurrence/);
});

test("dynamic operations are locked, revisioned, idempotent, and reconciled", async () => {
  await mkdir(paths.scheduledJobs, { recursive: true });
  await atomicWriteJson(paths.scheduledJobTasks, { tasks: [] });
  let reconciles = 0;
  setSchedulerReconciler(async () => {
    reconciles += 1;
  });
  const key = "test-create-idempotent";
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      createDynamicTask({
        name: "Stand up",
        prompt: "Remind the owner to stand up.",
        when: "in 30 minutes",
        timezone: "UTC",
        idempotencyKey: key,
      }),
    ),
  );
  assert.equal(new Set(attempts.map((entry) => entry.task.id)).size, 1);
  assert.equal(attempts.filter((entry) => entry.created).length, 1);
  const original = attempts[0].task;
  assert.equal(original.revision, 1);

  const updated = await updateDynamicTask({
    id: original.id,
    expectedRevision: 1,
    mutationKey: "rename-1",
    name: "Stand and stretch",
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "Stand and stretch");
  const replay = await updateDynamicTask({
    id: original.id,
    expectedRevision: 1,
    mutationKey: "rename-1",
    name: "ignored replay",
  });
  assert.equal(replay.id, updated.id);
  assert.equal(replay.revision, updated.revision);
  assert.equal(replay.name, updated.name);
  await assert.rejects(
    () => updateDynamicTask({ id: original.id, expectedRevision: 1, name: "stale" }),
    /Revision conflict/,
  );

  const snoozed = await snoozeDynamicTask(original.id, "in 2 hours", 2, "snooze-1");
  assert.equal(snoozed.revision, 3);
  assert.equal(snoozed.status, "pending");
  const cancelled = await cancelDynamicTask(original.id, 3, "cancel-1");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.revision, 4);
  assert.equal((await listDynamicTasks()).length, 0);
  assert.equal((await listDynamicTasks({ includeTerminal: true })).length, 1);
  assert.equal((await readDynamicTaskFile()).tasks.length, 1);
  assert.equal(reconciles, 4);
  setSchedulerReconciler(undefined);
});

test("a failed immediate reconcile cannot turn a committed mutation into an apparent failure", async () => {
  await mkdir(paths.scheduledJobs, { recursive: true });
  await atomicWriteJson(paths.scheduledJobTasks, { tasks: [] });
  setSchedulerReconciler(async () => {
    throw new Error("registration unavailable");
  });
  const result = await createDynamicTask({
    id: "reconcile-repair",
    name: "Repair later",
    prompt: "test",
    recurrence: "hourly",
  });
  assert.equal(result.created, true);
  assert.equal((await readDynamicTaskFile()).tasks[0]?.id, "reconcile-repair");
  setSchedulerReconciler(undefined);
});

test("collisions and unsafe task state changes fail closed", async () => {
  await mkdir(paths.scheduledJobs, { recursive: true });
  await atomicWriteJson(paths.scheduledJobTasks, { tasks: [] });
  await assert.rejects(
    () => createDynamicTask({ id: "nightly-memory-review", name: "Collision", prompt: "x", recurrence: "hourly" }),
    /reserved/,
  );
  const created = await createDynamicTask({ id: "state-test", name: "State", prompt: "x", when: "in 1 hour" });
  const file = await readDynamicTaskFile();
  const running = { ...created.task, status: "running", revision: 2 };
  await atomicWriteJson(paths.scheduledJobTasks, { tasks: [running] });
  await assert.rejects(() => cancelDynamicTask("state-test", 2), /running task cannot be cancelled/);
  await assert.rejects(() => snoozeDynamicTask("state-test", "in 2 hours", 2), /cannot be changed/);
  assert.equal(file.tasks.length, 1);
});
