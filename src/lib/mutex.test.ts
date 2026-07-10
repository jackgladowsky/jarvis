import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { withLock } from "./mutex.js";

const execFileAsync = promisify(execFile);

test("withLock continues the queue after a rejected task", async () => {
  const order: string[] = [];
  const first = withLock("queue", async () => {
    order.push("first");
    throw new Error("expected failure");
  });
  const second = withLock("queue", async () => {
    order.push("second");
    return 42;
  });

  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 42);
  assert.deepEqual(order, ["first", "second"]);
});

test("handled lock rejection does not create an unhandled finally rejection", async () => {
  const moduleUrl = new URL("./mutex.js", import.meta.url).href;
  const script = [
    `import { withLock } from ${JSON.stringify(moduleUrl)};`,
    `await withLock("key", async () => { throw new Error("handled"); }).catch(() => undefined);`,
    `await new Promise((resolve) => setImmediate(resolve));`,
  ].join("\n");

  await assert.doesNotReject(() =>
    execFileAsync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", script]),
  );
});

test("numeric chat locks serialize separate JARVIS processes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-chat-lock-"));
  const output = join(dataDir, "order.log");
  const moduleUrl = new URL("./mutex.js", import.meta.url).href;
  const script = [
    `import { appendFile } from "node:fs/promises";`,
    `import { withLock } from ${JSON.stringify(moduleUrl)};`,
    `await withLock(4242, async () => {`,
    `  await appendFile(process.env.OUTPUT, process.env.LABEL + ":start\\n");`,
    `  await new Promise((resolve) => setTimeout(resolve, 75));`,
    `  await appendFile(process.env.OUTPUT, process.env.LABEL + ":end\\n");`,
    `});`,
  ].join("\n");

  try {
    const run = (label: string) =>
      execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        env: { ...process.env, JARVIS_DATA_DIR: dataDir, OUTPUT: output, LABEL: label },
      });
    await Promise.all([run("a"), run("b")]);

    const lines = (await readFile(output, "utf-8")).trim().split("\n");
    assert.ok(
      ["a:start,a:end,b:start,b:end", "b:start,b:end,a:start,a:end"].includes(lines.join(",")),
      `chat turns overlapped: ${lines.join(",")}`,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
