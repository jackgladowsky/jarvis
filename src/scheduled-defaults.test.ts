import test from "node:test";
import assert from "node:assert/strict";
import { builtInScheduledTasks } from "./scheduled-defaults.js";

test("nightly-memory-review prompt requires bounded session inspection", () => {
  const task = builtInScheduledTasks.find((candidate) => candidate.id === "nightly-memory-review");
  assert.ok(task);

  const prompt = task.prompt;
  assert.match(prompt, /Hard context budget/);
  assert.match(prompt, /Never `cat` or full-`read` `.jsonl` transcripts/);
  assert.match(prompt, /`wc -l`\/`wc -c`/);
  assert.match(prompt, /`read` tool with `limit`/);
  assert.match(prompt, /`rg -n -m`/);
  assert.match(prompt, /`jq` projections that truncate message text/);
  assert.match(prompt, /Verification commands must print only changed sections/);
  assert.match(prompt, /First line must be exactly `NOTIFY: no`/);
});
