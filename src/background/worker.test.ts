import test from "node:test";
import assert from "node:assert/strict";
import { backgroundLifecycleNotificationId, parseWorkerOutcome, stageMustHalt } from "./worker-logic.js";

test("waiting and cancelled tasks halt the worker", () => {
  assert.equal(stageMustHalt({ status: "waiting_on_main" }), true);
  assert.equal(stageMustHalt({ status: "cancelled" }), true);
  assert.equal(stageMustHalt({ status: "running" }), false);
});

test("worker outcome is accepted only as an exact final marker", () => {
  assert.equal(parseWorkerOutcome("Implemented and tested.\nOUTCOME: completed"), "completed");
  assert.equal(parseWorkerOutcome("QUESTION: Which API?\nOUTCOME: blocked\n"), "blocked");
  assert.equal(parseWorkerOutcome("OUTCOME: completed\nOne more thought"), "invalid");
  assert.equal(parseWorkerOutcome("The outcome: completed successfully"), "invalid");
});

test("lifecycle notification IDs survive retries but change on a later same-status transition", () => {
  const transition = { id: "fern-sparrow", revision: 41 };
  const persistedId = backgroundLifecycleNotificationId(transition, "terminal-failed");
  assert.equal(persistedId, backgroundLifecycleNotificationId(transition, "terminal-failed"));
  assert.notEqual(persistedId, backgroundLifecycleNotificationId({ ...transition, revision: 44 }, "terminal-failed"));
  assert.match(persistedId, /^bg-16-fern-sparrow-terminal-failed$/);
});

test("repeated bootstrap failures use distinct lifecycle generations", () => {
  const firstFailure = { id: "fern-sparrow", revision: 8 };
  const firstId = backgroundLifecycleNotificationId(firstFailure, "terminal-failed");
  const laterId = backgroundLifecycleNotificationId({ ...firstFailure, revision: 10 }, "terminal-failed");
  assert.notEqual(firstId, laterId);
});
