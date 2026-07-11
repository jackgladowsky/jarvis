import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-restart-"));
  await mkdir(join(root, "prompts"), { recursive: true });
  await writeFile(join(root, "config.yaml"), await readFile(new URL("../../config.yaml.example", import.meta.url)));
  await writeFile(join(root, "prompts/system.md"), "test");
  process.env.JARVIS_DATA_DIR = root;
  process.env.TELEGRAM_BOT_TOKEN = "test";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.EXA_API_KEY = "test";
  return root;
}

test("guarded restart verifies only jarvis.service and detaches through the test seam", async () => {
  const root = await prepare();
  const { scheduleJarvisRestart } = await import(`./restart.js?test=${Date.now()}`);
  const calls: string[][] = [];
  let detached = 0;
  const exec = (async (_file: string, args: readonly string[]) => {
    calls.push([...args]);
    return { stdout: args.includes("show") ? "loaded\n" : "", stderr: "" };
  }) as any;
  await scheduleJarvisRestart("Apply timezone", "a".repeat(64), 5, {
    platform: "linux",
    exec,
    detach: (delay: number) => {
      detached = delay;
    },
  });
  assert.deepEqual(calls, [
    ["-n", "systemctl", "show", "jarvis.service", "--property=LoadState", "--value"],
    ["-n", "-l", "systemctl", "restart", "jarvis.service"],
  ]);
  assert.equal(detached, 5);
  const marker = JSON.parse(await readFile(join(root, "data/control/restart-pending.json"), "utf-8"));
  assert.equal(marker.reason, "Apply timezone");
  assert.equal(marker.chat_id, 1);
});

test("restart fails before service access without a notification destination and removes failed markers", async () => {
  const root = await prepare();
  const { scheduleJarvisRestart } = await import(`./restart.js?test=${Date.now()}destination`);
  let execCalls = 0;
  const exec = (async () => {
    execCalls++;
    return { stdout: "loaded\n", stderr: "" };
  }) as any;
  await assert.rejects(
    () =>
      scheduleJarvisRestart("x", "a".repeat(64), 5, {
        platform: "linux",
        notificationChatId: null,
        exec,
      }),
    /notification|allowlisted owner/i,
  );
  assert.equal(execCalls, 0);

  await assert.rejects(
    () =>
      scheduleJarvisRestart("x", "a".repeat(64), 5, {
        platform: "linux",
        notificationChatId: 1,
        exec,
        detach: () => {
          throw new Error("detach failed");
        },
      }),
    /detach failed/,
  );
  await assert.rejects(() => readFile(join(root, "data/control/restart-pending.json")), /ENOENT/);
});

test("restart rejects non-Linux and background worker contexts before service access", async () => {
  await prepare();
  const { scheduleJarvisRestart } = await import(`./restart.js?test=${Date.now()}b`);
  await assert.rejects(() => scheduleJarvisRestart("x", "a".repeat(64), 5, { platform: "darwin" }), /only on Linux/);
  process.env.JARVIS_BACKGROUND_BOOTSTRAPPED = "1";
  try {
    await assert.rejects(
      () => scheduleJarvisRestart("x", "a".repeat(64), 5, { platform: "linux" }),
      /background context/,
    );
  } finally {
    delete process.env.JARVIS_BACKGROUND_BOOTSTRAPPED;
  }
});
