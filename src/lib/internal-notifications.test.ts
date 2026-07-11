import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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

test("lossy caller IDs retain a collision-resistant suffix", async () => {
  const { mod } = await loaded;
  const common = "notification-id-that-is-deliberately-longer-than-forty-eight-characters-";
  const first = await mod.enqueueInternalNotification({
    id: `${common}one`,
    source: "scheduler",
    chat_id: 123,
    title: "First long ID",
    body: "First payload",
  });
  const second = await mod.enqueueInternalNotification({
    id: `${common}two`,
    source: "scheduler",
    chat_id: 123,
    title: "Second long ID",
    body: "Second payload",
  });

  assert.notEqual(first.id, second.id);
  assert.ok((await mod.listPendingInternalNotifications()).some((item) => item.id === first.id));
  assert.ok((await mod.listPendingInternalNotifications()).some((item) => item.id === second.id));
});

test("heartbeat distinguishes available main pump from fallback mode", async () => {
  const { mod, paths } = await loaded;
  assert.equal(await mod.mainNotificationPumpLooksAlive(), false);

  await mod.writeInternalNotificationHeartbeat();
  assert.equal(await mod.mainNotificationPumpLooksAlive(), true);

  await writeFile(
    paths.internalNotificationsHeartbeat,
    JSON.stringify({ updated_at: "2000-01-01T00:00:00.000Z" }),
    "utf-8",
  );
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
  await writeFile(
    join(paths.internalNotifications, `${notification.id}.json`),
    JSON.stringify(
      {
        ...notification,
        status: "running",
        updated_at: "2000-01-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  const pending = await mod.listPendingInternalNotifications();
  assert.ok(pending.some((item) => item.id === notification.id));
});

test(
  "stale claims are not stolen from a live matching process identity",
  { skip: process.platform !== "linux" && "requires Linux /proc process identity" },
  async () => {
    const { mod, paths } = await loaded;
    const notification = await mod.enqueueInternalNotification({
      id: "live-stale-owner-test",
      source: "background",
      chat_id: 123,
      title: "Live owner",
      body: "Do not steal",
    });
    const claimed = await mod.claimInternalNotification(notification);
    assert.ok(claimed?.claim_owner_start_time);
    claimed!.updated_at = "2000-01-01T00:00:00.000Z";
    const runningPath = join(paths.internalNotifications, `${claimed!.id}.${claimed!.claim_token}.running.json`);
    await writeFile(runningPath, `${JSON.stringify(claimed, null, 2)}\n`, "utf-8");
    assert.ok(!(await mod.listPendingInternalNotifications()).some((item) => item.id === claimed!.id));

    claimed!.claim_owner_start_time = "0";
    await writeFile(runningPath, `${JSON.stringify(claimed, null, 2)}\n`, "utf-8");
    assert.ok((await mod.listPendingInternalNotifications()).some((item) => item.id === claimed!.id));
    const reclaimed = await mod.claimInternalNotification(claimed!);
    await mod.finishInternalNotification(reclaimed!, "processed");
  },
);

test("notification claims are atomic across competing pumps", async () => {
  const { mod } = await loaded;
  const notification = await mod.enqueueInternalNotification({
    id: "atomic-claim-test",
    source: "background",
    chat_id: 123,
    title: "Atomic claim",
    body: "Only once",
  });

  const claims = await Promise.all([
    mod.claimInternalNotification(notification),
    mod.claimInternalNotification(notification),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claimed = claims.find(Boolean)!;
  await mod.finishInternalNotification(claimed, "processed");
});

test("failed delivery returns to the pending queue with backoff", async () => {
  const { mod, paths } = await loaded;
  const notification = await mod.enqueueInternalNotification({
    id: "delivery-retry-test",
    source: "scheduler",
    chat_id: 123,
    title: "Retry delivery",
    body: "Try later",
  });
  const claimed = await mod.claimInternalNotification(notification);
  assert.ok(claimed);
  await mod.finishInternalNotification(claimed!, "failed", "network down");

  const parsed = JSON.parse(await readFile(join(paths.internalNotifications, `${notification.id}.json`), "utf-8")) as {
    status: string;
    attempts: number;
    next_attempt_at?: string;
    error?: string;
  };
  assert.equal(parsed.status, "pending");
  assert.equal(parsed.attempts, 1);
  assert.equal(parsed.error, "network down");
  assert.ok(Date.parse(parsed.next_attempt_at ?? "") > Date.now());
  assert.ok(!(await readdir(paths.internalNotifications)).some((name) => name.includes(".running.json")));
});

test("a reclaimed notification fences the old delivery owner", async () => {
  const { mod } = await loaded;
  const notification = await mod.enqueueInternalNotification({
    id: "claim-fencing-test",
    source: "background",
    chat_id: 123,
    title: "Claim fencing",
    body: "Fence stale owner",
  });
  const first = await mod.claimInternalNotification(notification);
  assert.ok(first);
  const second = await mod.claimInternalNotification(first!);
  assert.ok(second);
  await assert.rejects(mod.finishInternalNotification(first!, "processed"), /claim was lost/);
  await mod.finishInternalNotification(second!, "processed");
});

test("terminal rename is safe if metadata rewrite never happens", async () => {
  const { mod, paths } = await loaded;
  const notification = await mod.enqueueInternalNotification({
    id: "terminal-rename-crash-test",
    source: "background",
    chat_id: 123,
    title: "Terminal commit",
    body: "Do not replay",
  });
  const claimed = await mod.claimInternalNotification(notification);
  assert.ok(claimed?.claim_token);
  await mkdir(paths.internalNotificationsArchive, { recursive: true });
  await rename(
    join(paths.internalNotifications, `${claimed!.id}.${claimed!.claim_token}.running.json`),
    join(paths.internalNotificationsArchive, `processed-${claimed!.id}.json`),
  );

  assert.ok(!(await mod.listPendingInternalNotifications()).some((item) => item.id === claimed!.id));
  const duplicate = await mod.enqueueInternalNotification({
    id: claimed!.id,
    source: "background",
    chat_id: 123,
    title: "Terminal commit",
    body: "Do not replay",
  });
  assert.equal(duplicate.status, "processed");
});

test("dead-pump fallback atomically claims deterministic notifications", async () => {
  const { mod, paths } = await loaded;
  await writeFile(
    paths.internalNotificationsHeartbeat,
    JSON.stringify({ updated_at: "2000-01-01T00:00:00.000Z" }),
    "utf-8",
  );
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const input = {
      id: "dead-pump-idempotence",
      source: "scheduler" as const,
      chat_id: 123,
      title: "Only once",
      body: "Only one fallback should escape",
    };
    await Promise.all([mod.notifyMainOrFallback(input), mod.notifyMainOrFallback(input)]);
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
