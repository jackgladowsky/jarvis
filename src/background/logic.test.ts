import test from "node:test";
import assert from "node:assert/strict";
import {
  backgroundModelOverrideForRole,
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

test("background model routing selects Codex models by worker role", () => {
  const sol = { provider: "codex", model: "gpt-5.6-sol" };
  const terra = { provider: "codex", model: "gpt-5.6-terra" };

  assert.deepEqual(backgroundModelOverrideForRole("planner"), sol);
  assert.deepEqual(backgroundModelOverrideForRole("researcher"), sol);
  assert.deepEqual(backgroundModelOverrideForRole("reviewer"), sol);
  assert.deepEqual(backgroundModelOverrideForRole("implementer"), terra);
  assert.deepEqual(backgroundModelOverrideForRole("fixer"), terra);
});

test("background model routing falls back to the active model for unknown roles", () => {
  assert.equal(backgroundModelOverrideForRole("unknown"), undefined);
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
