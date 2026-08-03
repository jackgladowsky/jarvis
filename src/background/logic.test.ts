import test from "node:test";
import assert from "node:assert/strict";
import { backgroundWorkerInstructions, friendlyIdFromUuid, renderTask, renderTaskList } from "./logic.js";
import type { BackgroundTask } from "./types.js";

test("friendlyIdFromUuid is stable and human-shaped", () => {
  assert.equal(friendlyIdFromUuid("93226887-6c09-4b49-96a1-72815b018cf1"), "fern-sparrow");
  assert.match(friendlyIdFromUuid("00000000-0000-0000-0000-000000000000"), /^[a-z]+-[a-z]+$/);
});

test("single worker instructions cover the full bounded workflow", () => {
  const instructions = backgroundWorkerInstructions().join("\n");
  assert.match(instructions, /investigation through verified handoff/);
  assert.match(instructions, /implementation plan/);
  assert.match(instructions, /run checks appropriate/);
  assert.match(instructions, /commit all intended changes/);
  assert.match(instructions, /must never push, merge, deploy, restart services, or edit the main checkout/);
  assert.match(instructions, /Do not perform unrelated cleanup/);
});

test("renderTask and renderTaskList produce concise operator output without roles", () => {
  const task: BackgroundTask = {
    id: "fern-sparrow",
    uuid: "u",
    name: "Improve tests",
    status: "running",
    prompt: "Improve tests",
    repo: "/repo",
    worktree: "/tmp/fern-sparrow",
    branch: "worker/fern-sparrow",
    chat_id: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    summary: "Working",
  };

  assert.match(renderTask(task), /fern-sparrow — running/);
  assert.doesNotMatch(renderTask(task), /Pipeline|role/);
  assert.equal(renderTaskList([]), "No background tasks.");
  assert.match(renderTaskList([task]), /fern-sparrow — running — fern-sparrow/);
});
