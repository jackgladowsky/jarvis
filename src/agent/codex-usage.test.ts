import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function usageModule() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-codex-usage-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test prompt");
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      "agent: { provider: codex, model: gpt-5.1 }",
      "session: { inactivity_threshold_minutes: 60, max_duration_hours: 24, summarize_on_rotation: false, announce_new_session: false }",
      "compaction: { enabled: false, reserve_tokens: 1000, keep_recent_tokens: 100 }",
      "tools: { bash: { default_timeout_seconds: 30, max_timeout_seconds: 120 } }",
      "telegram: { show_typing: false, long_tool_call_seconds: 5, parse_mode: none }",
      "stt: { provider: disabled, local_whisper_cpp: { whisper_binary_path: /tmp/whisper-cli, model_path: /tmp/ggml-base.en.bin, ffmpeg_path: /usr/bin/ffmpeg, max_audio_mb: 25, timeout_seconds: 120 } }",
      "scheduler: { enabled: false, timezone: UTC, telegram_chat_id: 0, tasks: [] }",
      "logging: { audit_log_enabled: false, audit_log_max_value_bytes: 2048, audit_log_redact_patterns: true, level: info }",
      "",
    ].join("\n"),
  );
  return import("./codex-usage.js");
}

const validPayload = {
  rate_limit: {
    primary_window: { used_percent: 55.5, reset_after_seconds: 2547 },
    secondary_window: { used_percent: 51, reset_after_seconds: 489405 },
  },
};

test("parses normal two-window Codex quota responses", async () => {
  const { parseCodexSubscriptionUsage } = await usageModule();
  assert.deepEqual(parseCodexSubscriptionUsage(validPayload), {
    available: true,
    primary: { usedPercent: 55.5, resetAfterSeconds: 2547 },
    secondary: { usedPercent: 51, resetAfterSeconds: 489405 },
  });
});

test("parses a primary-only Codex quota response", async () => {
  const { parseCodexSubscriptionUsage } = await usageModule();
  assert.deepEqual(
    parseCodexSubscriptionUsage({
      rate_limit: { primary_window: { used_percent: 55.5, reset_after_seconds: 2547 }, secondary_window: null },
    }),
    {
      available: true,
      primary: { usedPercent: 55.5, resetAfterSeconds: 2547 },
    },
  );
});

test("treats malformed or missing primary Codex quota windows as unavailable", async () => {
  const { parseCodexSubscriptionUsage } = await usageModule();
  assert.deepEqual(parseCodexSubscriptionUsage({ rate_limit: { secondary_window: null } }), {
    available: false,
    reason: "unavailable",
  });
  assert.deepEqual(parseCodexSubscriptionUsage({ rate_limit: { primary_window: {} } }), {
    available: false,
    reason: "unavailable",
  });
});

test("renders primary-only and two-window Codex quota responses", async () => {
  const { parseCodexSubscriptionUsage, renderCodexSubscriptionUsage } = await usageModule();
  assert.equal(
    renderCodexSubscriptionUsage(parseCodexSubscriptionUsage(validPayload)),
    "📈 Codex subscription\n• 5-hour: 55.5% used · 44.5% left · resets in 43m\n• Weekly: 51% used · 49% left · resets in 5d 15h",
  );
  assert.equal(
    renderCodexSubscriptionUsage(
      parseCodexSubscriptionUsage({
        rate_limit: { primary_window: { used_percent: 55.5, reset_after_seconds: 2547 }, secondary_window: null },
      }),
    ),
    "📈 Codex subscription\n• 5-hour: 55.5% used · 44.5% left · resets in 43m",
  );
});

test("tolerates reset epochs", async () => {
  const { parseCodexSubscriptionUsage, renderCodexSubscriptionUsage } = await usageModule();
  const fromEpoch = parseCodexSubscriptionUsage(
    {
      rate_limit: {
        primary_window: { used_percent: -2, reset_at: 1_700_000_060 },
        secondary_window: { used_percent: 101, reset_at: 1_700_003_600_000 },
      },
    },
    1_700_000_000_000,
  );
  assert.deepEqual(fromEpoch, {
    available: true,
    primary: { usedPercent: 0, resetAfterSeconds: 60 },
    secondary: { usedPercent: 100, resetAfterSeconds: 3600 },
  });
  assert.equal(
    renderCodexSubscriptionUsage({ available: false, reason: "auth" }),
    "📈 Codex subscription\n• authentication unavailable",
  );
});

test("uses OAuth auth headers and force-refreshes exactly once after a 401", async () => {
  const { getCodexSubscriptionUsage } = await usageModule();
  const calls: Array<{ auth: boolean; headers?: RequestInit["headers"] }> = [];
  const getAuth = async (forceRefresh = false) => {
    calls.push({ auth: forceRefresh });
    return forceRefresh
      ? { accessToken: "refreshed-token", accountId: "account-2" }
      : { accessToken: "old-token", accountId: "account-1" };
  };
  const responses = [new Response(null, { status: 401 }), new Response(JSON.stringify(validPayload), { status: 200 })];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ auth: false, headers: init?.headers });
    return responses.shift()!;
  };

  const usage = await getCodexSubscriptionUsage({ getAuth, fetch });
  assert.equal(usage.available, true);
  assert.equal(calls.filter((call) => call.headers).length, 2);
  assert.deepEqual(
    calls.filter((call) => !call.headers).map((call) => call.auth),
    [false, true],
  );
  const firstHeaders = calls.find((call) => call.headers)?.headers as Record<string, string>;
  const secondHeaders = calls.filter((call) => call.headers)[1]?.headers as Record<string, string>;
  assert.equal(firstHeaders.Authorization, "Bearer old-token");
  assert.equal(secondHeaders.Authorization, "Bearer refreshed-token");
  assert.equal(secondHeaders["ChatGPT-Account-Id"], "account-2");
});

test("does not retry denied, malformed, or network responses", async () => {
  const { getCodexSubscriptionUsage } = await usageModule();
  let authCalls = 0;
  const getAuth = async () => {
    authCalls += 1;
    return { accessToken: "token" };
  };
  let fetchCalls = 0;
  const denied = await getCodexSubscriptionUsage({
    getAuth,
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 403 });
    },
  });
  assert.deepEqual(denied, { available: false, reason: "auth" });
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 1);

  const malformed = await getCodexSubscriptionUsage({
    getAuth,
    fetch: async () => new Response("{}", { status: 200 }),
  });
  assert.deepEqual(malformed, { available: false, reason: "unavailable" });
  const offline = await getCodexSubscriptionUsage({
    getAuth,
    fetch: async () => Promise.reject(new Error("offline")),
  });
  assert.deepEqual(offline, { available: false, reason: "unavailable" });
});
