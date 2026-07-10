import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openaiCodexOAuthProvider } from "@mariozechner/pi-ai/oauth";

test("concurrent OAuth callers share one refresh and persist credentials atomically", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-auth-"));
  const creds = join(dataDir, "codex-creds.json");
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.CODEX_OAUTH_CREDS_PATH = creds;
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
  await writeFile(creds, JSON.stringify({ access: "old-access", refresh: "old-refresh", expires: 1 }), "utf-8");
  await chmod(creds, 0o600);

  const originalRefresh = openaiCodexOAuthProvider.refreshToken;
  let refreshCalls = 0;
  openaiCodexOAuthProvider.refreshToken = async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
  };
  try {
    const { getCodexAccessToken } = await import("./auth.js");
    const tokens = await Promise.all(Array.from({ length: 12 }, () => getCodexAccessToken()));

    assert.deepEqual(new Set(tokens), new Set(["new-access"]));
    assert.equal(refreshCalls, 1);
    assert.equal(JSON.parse(await readFile(creds, "utf-8")).refresh, "new-refresh");
    assert.equal((await stat(creds)).mode & 0o777, 0o600);
  } finally {
    openaiCodexOAuthProvider.refreshToken = originalRefresh;
    await rm(dataDir, { recursive: true, force: true });
  }
});
