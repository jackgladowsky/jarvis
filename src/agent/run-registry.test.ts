import test from "node:test";
import assert from "node:assert/strict";
import { AgentRunRegistry } from "./run-registry.js";

test("active run registry tracks, cancels, and settles runs", async () => {
  const registry = new AgentRunRegistry();
  const run = registry.start("chat", 123);

  assert.equal(registry.activeCount(), 1);
  assert.equal(registry.cancel("chat", 123, "test cancel"), true);
  assert.equal(run.signal.aborted, true);
  assert.equal(await registry.waitForIdle(5), false);

  run.finish();
  assert.equal(registry.activeCount(), 0);
  assert.equal(await registry.waitForIdle(50), true);
});

test("newer run supersedes older run for the same key", () => {
  const registry = new AgentRunRegistry();
  const oldRun = registry.start("chat", 123);
  const newRun = registry.start("chat", 123);

  assert.equal(oldRun.signal.aborted, true);
  assert.equal(oldRun.isCurrent(), false);
  assert.equal(newRun.isCurrent(), true);

  assert.equal(registry.cancel("chat", 123), true);
  assert.equal(newRun.signal.aborted, true);
  oldRun.finish();
  newRun.finish();
});
