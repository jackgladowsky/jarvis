import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("workbench lock serializes runs and cancellation stops a waiter before entry", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-workbench-lock-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  const { withWorkbenchLock } = await import("./lock.js");

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const first = withWorkbenchLock(undefined, async () => {
    firstEntered();
    await firstGate;
    return "first";
  });
  await entered;

  let secondEntered = false;
  const controller = new AbortController();
  const second = withWorkbenchLock(controller.signal, async () => {
    secondEntered = true;
    return "second";
  });
  setTimeout(() => controller.abort(new Error("cancel waiting workbench")), 50);

  try {
    await assert.rejects(second, /cancel waiting workbench/);
    assert.equal(secondEntered, false);
  } finally {
    releaseFirst();
    assert.equal(await first, "first");
    await rm(dataDir, { recursive: true, force: true });
  }
});
