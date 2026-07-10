import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-deploy-notify-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.JARVIS_SOURCE_ROOT = process.cwd();
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await mkdir(join(dataDir, "data", "deploy"), { recursive: true });
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
      "  telegram_chat_id: 123",
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
  const mod = await import("./deploy-notify.js");
  const { paths } = await import("../paths.js");
  return { dataDir, mod, paths };
}

test("deploy readiness deduplicates one event but not a later deploy of the same commit", async () => {
  const { mod, paths } = await setup();
  const deploy = {
    started_at: "2026-07-09T12:00:00.000Z",
    old_rev: "a".repeat(40),
    new_rev: "b".repeat(40),
    target_ref: "origin/main",
  };
  const writeMarker = (value: typeof deploy) => writeFile(paths.deployPending, `${JSON.stringify(value)}\n`, "utf-8");

  await writeMarker(deploy);
  await mod.notifyPendingDeployComplete();

  // Model a crash after deterministic enqueue but before marker
  // acknowledgement by restoring the exact same event marker.
  await writeMarker(deploy);
  await mod.notifyPendingDeployComplete();

  let notificationFiles = (await readdir(paths.internalNotifications)).filter((name) => name.endsWith(".json"));
  assert.equal(notificationFiles.length, 1);
  assert.match(notificationFiles[0], /^deploy-complete-bbbbbbb-[0-9a-f]{16}\.json$/);
  assert.match(await readFile(join(paths.internalNotifications, notificationFiles[0]), "utf-8"), /back online/);

  // A later deploy is a new lifecycle event even when it targets the same SHA.
  await writeMarker({ ...deploy, started_at: "2026-07-10T12:00:00.000Z" });
  await mod.notifyPendingDeployComplete();
  notificationFiles = (await readdir(paths.internalNotifications)).filter((name) => name.endsWith(".json")).sort();
  assert.equal(notificationFiles.length, 2);
  assert.notEqual(notificationFiles[0], notificationFiles[1]);
  assert.ok((await readdir(join(paths.data, "data", "deploy"))).some((name) => name.startsWith("queued-")));
});
