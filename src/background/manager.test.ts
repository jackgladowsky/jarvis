import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackgroundTask } from "./types.js";

async function prepare() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-background-manager-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.JARVIS_SOURCE_ROOT = process.cwd();
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test prompt", "utf-8");
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      "agent:",
      "  provider: codex",
      "  model: gpt-5.1",
      "session:",
      "  inactivity_threshold_minutes: 60",
      "  max_duration_hours: 24",
      "  summarize_on_rotation: false",
      "  announce_new_session: false",
      "compaction:",
      "  enabled: true",
      "  reserve_tokens: 100",
      "  keep_recent_tokens: 10",
      "tools:",
      "  bash:",
      "    default_timeout_seconds: 30",
      "    max_timeout_seconds: 120",
      "background:",
      "  max_concurrent_workers: 2",
      "  role_models: {}",
      "telegram:",
      "  show_typing: false",
      "  long_tool_call_seconds: 5",
      "  parse_mode: none",
      "stt:",
      "  provider: disabled",
      "  local_whisper_cpp:",
      "    whisper_binary_path: /tmp/whisper-cli",
      "    model_path: /tmp/ggml-base.en.bin",
      "    ffmpeg_path: /usr/bin/ffmpeg",
      "    max_audio_mb: 25",
      "    timeout_seconds: 120",
      "scheduler:",
      "  enabled: false",
      "  timezone: UTC",
      "  telegram_chat_id: 0",
      "  tasks: []",
      "logging:",
      "  audit_log_enabled: false",
      "  audit_log_max_value_bytes: 2048",
      "  audit_log_redact_patterns: true",
      "  level: info",
      "",
    ].join("\n"),
    "utf-8",
  );
  const manager = await import("./manager.js");
  return { dataDir, manager };
}

function makeTask(id: string): BackgroundTask {
  const timestamp = new Date().toISOString();
  return {
    id,
    uuid: `uuid-${id}`,
    name: "test task",
    status: "queued",
    prompt: "test",
    repo: process.cwd(),
    worktree: join(tmpdir(), id),
    branch: `worker/${id}`,
    chat_id: 123,
    pipeline: [{ role: "implementer", status: "queued" }],
    current_role: "implementer",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("background task state uses CAS, guards transitions, and clears terminal PIDs safely", async () => {
  const { dataDir, manager } = await prepare();
  try {
    const task = makeTask("test-task");
    await manager.writeBackgroundTask(task);
    assert.equal(task.revision, 1);

    const first = await manager.readBackgroundTask(task.id);
    const stale = await manager.readBackgroundTask(task.id);
    first.name = "winner";
    await manager.writeBackgroundTask(first);
    stale.name = "lost update";
    await assert.rejects(manager.writeBackgroundTask(stale), /changed concurrently/);

    await assert.rejects(manager.answerBackgroundTask(task.id, "answer"), /expected waiting_on_main/);
    await assert.rejects(manager.readBackgroundTask("../escape"), /invalid background task id/);

    const deferred = makeTask("deferred-task");
    deferred.launch_deferred = true;
    await manager.writeBackgroundTask(deferred);
    await assert.rejects(manager.launchBackgroundTask(deferred.id), /waiting for its goal reservation/);
    await manager.activateDeferredBackgroundTask(deferred.id);
    assert.equal((await manager.readBackgroundTask(deferred.id)).launch_deferred, undefined);

    const taskFile = join(dataDir, "data", "background", "tasks", `${task.id}.json`);
    const terminal = { ...first, status: "done", pid: process.pid } satisfies BackgroundTask;
    await writeFile(taskFile, `${JSON.stringify(terminal, null, 2)}\n`, "utf-8");
    const cancelled = await manager.cancelBackgroundTask(task.id);
    assert.equal(cancelled.status, "done");
    assert.equal(cancelled.pid, undefined);
    assert.doesNotThrow(() => process.kill(process.pid, 0));

    const mailDir = join(dataDir, "data", "background", "mail");
    await mkdir(mailDir, { recursive: true });
    await writeFile(
      join(mailDir, `${task.id}.jsonl`),
      '{"ts":"x","from":"main","type":"status","body":"ok"}\n{"partial":',
    );
    assert.equal((await manager.readBackgroundMail(task.id)).length, 1);
    assert.ok((await readdir(mailDir)).some((entry) => entry.includes(".corrupt-")));
    assert.equal((JSON.parse(await readFile(taskFile, "utf-8")) as BackgroundTask).pid, undefined);

    const failedSpawn = Object.assign(new EventEmitter(), { pid: undefined as number | undefined, unref() {} });
    const failedAcknowledgement = manager.waitForSpawnAcknowledgement(failedSpawn);
    failedSpawn.emit("error", new Error("spawn ENOENT"));
    await assert.rejects(failedAcknowledgement, /spawn ENOENT/);

    const successfulSpawn = Object.assign(new EventEmitter(), { pid: 4242 as number | undefined, unref() {} });
    const successfulAcknowledgement = manager.waitForSpawnAcknowledgement(successfulSpawn);
    successfulSpawn.emit("spawn");
    assert.equal(await successfulAcknowledgement, 4242);

    const sourceRoot = process.env.JARVIS_SOURCE_ROOT;
    process.env.JARVIS_SOURCE_ROOT = join(dataDir, "missing-source-root");
    try {
      await assert.rejects(manager.spawnBackgroundWorker("spawn-test"), /ENOENT/);
    } finally {
      if (sourceRoot === undefined) delete process.env.JARVIS_SOURCE_ROOT;
      else process.env.JARVIS_SOURCE_ROOT = sourceRoot;
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
