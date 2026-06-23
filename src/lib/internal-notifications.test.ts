import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-notifications-test-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test prompt", "utf-8");
  await writeFile(join(dataDir, "config.yaml"), [
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
  ].join("\n"), "utf-8");
  const mod = await import("./internal-notifications.js");
  const { paths } = await import("../paths.js");
  return { mod, paths };
}

const loaded = setup();

test("internal notifications are queued and rendered as main-session prompts", async () => {
  const { mod } = await loaded;
  const notification = await mod.enqueueInternalNotification({
    source: "scheduler",
    chat_id: 123,
    title: "Test task",
    body: "Body text",
  });

  const pending = await mod.listPendingInternalNotifications();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, notification.id);
  assert.match(mod.renderInternalNotificationPrompt(notification), /current Telegram conversation/);
  assert.match(mod.renderInternalNotificationPrompt(notification), /Body text/);
});

test("heartbeat distinguishes available main pump from fallback mode", async () => {
  const { mod, paths } = await loaded;
  assert.equal(await mod.mainNotificationPumpLooksAlive(), false);

  await mod.writeInternalNotificationHeartbeat();
  assert.equal(await mod.mainNotificationPumpLooksAlive(), true);

  await writeFile(paths.internalNotificationsHeartbeat, JSON.stringify({ updated_at: "2000-01-01T00:00:00.000Z" }), "utf-8");
  assert.equal(await mod.mainNotificationPumpLooksAlive(), false);
});

test("stale running notifications are retried", async () => {
  const { mod, paths } = await loaded;
  const notification = await mod.enqueueInternalNotification({
    id: "stale-running-test",
    source: "background",
    chat_id: 123,
    title: "Stale running",
    body: "Retry me",
  });
  await writeFile(join(paths.internalNotifications, `${notification.id}.json`), JSON.stringify({
    ...notification,
    status: "running",
    updated_at: "2000-01-01T00:00:00.000Z",
  }, null, 2) + "\n", "utf-8");

  const pending = await mod.listPendingInternalNotifications();
  assert.ok(pending.some((item) => item.id === notification.id));
});
