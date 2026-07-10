import test from "node:test";
import assert from "node:assert/strict";
import {
  appendAutomaticFixerCycle,
  backgroundModelOverrideForRole,
  backgroundWorkerInstructions,
  choosePipeline,
  friendlyIdFromUuid,
  nextQueuedRole,
  renderTask,
  renderTaskList,
} from "./logic.js";
import type { BackgroundTask } from "./types.js";

function roles(prompt: string): string[] {
  return choosePipeline(prompt).map((stage) => stage.role);
}

test("choosePipeline routes research, implementation, and mixed prompts", () => {
  assert.deepEqual(roles("research options for backups"), ["researcher", "reviewer"]);
  assert.deepEqual(roles("implement the backup command"), ["implementer", "reviewer"]);
  assert.deepEqual(roles("research and implement backup improvements"), ["researcher", "implementer", "reviewer"]);
});

test("friendlyIdFromUuid is stable and human-shaped", () => {
  assert.equal(friendlyIdFromUuid("93226887-6c09-4b49-96a1-72815b018cf1"), "fern-sparrow");
  assert.match(friendlyIdFromUuid("00000000-0000-0000-0000-000000000000"), /^[a-z]+-[a-z]+$/);
});

test("background model routing inherits active model unless a role override is configured", () => {
  const routes = {
    researcher: { provider: "anthropic" as const, model: "claude-sonnet-4-6" },
    implementer: { provider: "openrouter" as const, model: "openai/gpt-5" },
  };

  assert.equal(backgroundModelOverrideForRole("reviewer", routes), undefined);
  assert.deepEqual(backgroundModelOverrideForRole("researcher", routes), routes.researcher);
  assert.deepEqual(backgroundModelOverrideForRole("implementer", routes), routes.implementer);
});

test("unknown roles use active-model routing and generic worker instructions", () => {
  assert.equal(backgroundModelOverrideForRole("unknown"), undefined);
  assert.match(backgroundWorkerInstructions("unknown").join("\n"), /Role: unknown\./);
  assert.match(backgroundWorkerInstructions("unknown").join("\n"), /No specialized instructions exist/);
});

test("pipeline routing uses word boundaries instead of accidental substrings", () => {
  assert.deepEqual(roles("compare pricing options"), ["researcher", "reviewer"]);
  assert.deepEqual(roles("improve command reliability"), ["implementer", "reviewer"]);
  assert.deepEqual(roles("research and improve command reliability"), ["researcher", "implementer", "reviewer"]);
});

test("automatic fixer cycle appends exactly one fixer and final reviewer", () => {
  const task: Pick<BackgroundTask, "pipeline" | "automatic_fix_attempted"> = {
    pipeline: [{ role: "reviewer", status: "done" }],
  };

  assert.equal(appendAutomaticFixerCycle(task), true);
  assert.equal(task.automatic_fix_attempted, true);
  assert.deepEqual(
    task.pipeline.map((stage) => stage.role),
    ["reviewer", "fixer", "reviewer"],
  );
  assert.equal(appendAutomaticFixerCycle(task), false);
  assert.equal(task.pipeline.length, 3);
});

test("nextQueuedRole returns the first queued stage", () => {
  assert.equal(
    nextQueuedRole({
      pipeline: [
        { role: "researcher", status: "done" },
        { role: "reviewer", status: "queued" },
      ],
    }),
    "reviewer",
  );
  assert.equal(nextQueuedRole({ pipeline: [{ role: "reviewer", status: "done" }] }), undefined);
});

test("renderTask and renderTaskList produce concise operator output", () => {
  const task: BackgroundTask = {
    id: "fern-sparrow",
    uuid: "u",
    name: "Audit tests",
    status: "awaiting_review",
    prompt: "Audit tests",
    repo: "/repo",
    worktree: "/tmp/fern-sparrow",
    branch: "worker/fern-sparrow",
    chat_id: 1,
    pipeline: [
      { role: "implementer", status: "done" },
      { role: "reviewer", status: "queued" },
    ],
    current_role: "reviewer",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    summary: "Implemented tests",
  };

  assert.match(renderTask(task), /fern-sparrow — awaiting_review/);
  assert.match(renderTask(task), /Pipeline: implementer:done -> reviewer:queued/);
  assert.equal(renderTaskList([]), "No background tasks.");
  assert.match(renderTaskList([task]), /fern-sparrow — awaiting_review current:reviewer/);
});
