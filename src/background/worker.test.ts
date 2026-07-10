import test from "node:test";
import assert from "node:assert/strict";
import {
  backgroundLifecycleNotificationId,
  parseReviewVerdict,
  parseWorkerOutcome,
  stageMustHalt,
} from "./worker-logic.js";

test("review verdict is accepted only from the exact first nonempty line", () => {
  assert.equal(parseReviewVerdict("VERDICT: ready\nAll checks pass."), "ready");
  assert.equal(parseReviewVerdict("\n  VERDICT: needs_fix  \nFix tests."), "needs_fix");
  assert.equal(parseReviewVerdict("Needs work. After fixes, VERDICT: ready"), "needs_fix");
  assert.equal(parseReviewVerdict("Quoted output:\nVERDICT: ready"), "needs_fix");
  assert.equal(parseReviewVerdict("VERDICT: ready eventually"), "needs_fix");
});

test("waiting and cancelled tasks halt the pipeline", () => {
  assert.equal(stageMustHalt({ status: "waiting_on_main" }), true);
  assert.equal(stageMustHalt({ status: "cancelled" }), true);
  assert.equal(stageMustHalt({ status: "implementing" }), false);
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

  // writeBackgroundTask persists the transition at the next revision. A
  // later resume/bootstrap failure starts from that (or a newer) revision.
  const laterFailure = { ...firstFailure, revision: firstFailure.revision + 2 };
  const laterId = backgroundLifecycleNotificationId(laterFailure, "terminal-failed");

  assert.notEqual(firstId, laterId);
  assert.equal(firstId, backgroundLifecycleNotificationId(firstFailure, "terminal-failed"));
});
