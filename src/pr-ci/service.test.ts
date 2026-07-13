import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-pr-ci-test-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test", "utf8");
  await writeFile(
    join(dataDir, "config.yaml"),
    `agent:\n  provider: codex\n  model: gpt-5.1\nsession:\n  inactivity_threshold_minutes: 60\n  max_duration_hours: 24\n  summarize_on_rotation: false\n  announce_new_session: false\ncompaction:\n  enabled: true\n  reserve_tokens: 100\n  keep_recent_tokens: 10\ntools:\n  bash:\n    default_timeout_seconds: 30\n    max_timeout_seconds: 120\ntelegram:\n  show_typing: false\n  long_tool_call_seconds: 5\n  parse_mode: none\nstt:\n  provider: disabled\n  local_whisper_cpp:\n    whisper_binary_path: /tmp/whisper-cli\n    model_path: /tmp/model\n    ffmpeg_path: /usr/bin/ffmpeg\n    max_audio_mb: 25\n    timeout_seconds: 120\nscheduler:\n  enabled: false\n  timezone: UTC\n  telegram_chat_id: 123\n  tasks: []\nlogging:\n  audit_log_enabled: false\n  audit_log_max_value_bytes: 2048\n  audit_log_redact_patterns: true\n  level: info\n`,
    "utf8",
  );
  const service = await import("./service.js");
  const notifications = await import("../lib/internal-notifications.js");
  const { paths } = await import("../paths.js");
  await notifications.writeInternalNotificationHeartbeat(); // never use Telegram fallback in unit tests
  return { service, notifications, paths };
}
const loaded = setup();
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function client(checks: Array<{ name: string; status: string; conclusion: string | null }>, head = SHA_A) {
  return { getPr: async () => ({ headSha: head, state: "OPEN" as const }), getChecks: async () => checks };
}

test("success is durable, emits once, and includes exact SHA", async () => {
  const { service, notifications, paths } = await loaded;
  await service.startPrCiWatch({ repository: "jack/jarvis", pr_number: 12, head_sha: SHA_A, chat_id: 123 });
  await service.pollPrCiWatch(client([{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]));
  const state = JSON.parse(await readFile(paths.prCiWatch, "utf8"));
  assert.equal(state.status, "success");
  const pending = await notifications.listPendingInternalNotifications();
  assert.equal(pending.filter((item: { title: string }) => /CI passed/.test(item.title)).length, 1);
  assert.match(pending.at(-1)!.body, new RegExp(SHA_A));
  await service.pollPrCiWatch(client([{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]));
  assert.equal((await notifications.listPendingInternalNotifications()).length, 1);
});

test("a terminal result reconciles a later PR head push", async () => {
  const { service } = await loaded;
  await service.startPrCiWatch({ repository: "jack/jarvis", pr_number: 15, head_sha: SHA_A, chat_id: 123 });
  const at = Date.now();
  const green = await service.pollPrCiWatch(client([{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]), at);
  assert.equal(green?.status, "success");
  const reset = await service.pollPrCiWatch(client([], SHA_B), Date.parse(green!.next_poll_at));
  assert.equal(reset?.head_sha, SHA_B);
  assert.equal(reset?.status, "pending");
});

test("pending checks use bounded exponential backoff", async () => {
  const { service } = await loaded;
  await service.startPrCiWatch({ repository: "jack/jarvis", pr_number: 13, head_sha: SHA_A, chat_id: 123 });
  const at = Date.now();
  const state = await service.pollPrCiWatch(client([{ name: "CI", status: "IN_PROGRESS", conclusion: null }]), at);
  assert.equal(state?.attempt, 1);
  assert.equal(Date.parse(state!.next_poll_at) - at, service.PR_CI_INITIAL_DELAY_MS * 2);
  assert.equal(service.classifyChecks([]), "pending");
});

test("head changes reset state and failure notification is bounded and deduped", async () => {
  const { service, notifications } = await loaded;
  await service.startPrCiWatch({ repository: "jack/jarvis", pr_number: 14, head_sha: SHA_A, chat_id: 123 });
  const reset = await service.pollPrCiWatch(client([], SHA_B));
  assert.equal(reset?.head_sha, SHA_B);
  assert.equal(reset?.status, "pending");
  await service.pollPrCiWatch(
    client([{ name: "broken", status: "COMPLETED", conclusion: "FAILURE" }], SHA_B),
    Date.now() + 1,
  );
  const failed = (await notifications.listPendingInternalNotifications()).filter((item: { title: string }) =>
    /CI failed/.test(item.title),
  );
  assert.equal(failed.length, 1);
  await service.pollPrCiWatch(
    client([{ name: "broken", status: "COMPLETED", conclusion: "FAILURE" }], SHA_B),
    Date.now() + 2,
  );
  assert.equal(
    (await notifications.listPendingInternalNotifications()).filter((item: { title: string }) =>
      /CI failed/.test(item.title),
    ).length,
    1,
  );
  assert.ok(
    service.boundedFailureSummary(
      Array.from({ length: 500 }, (_, i) => ({
        name: `check-${i}`,
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://example.test/long",
      })),
    ).length <= 1500,
  );
});
