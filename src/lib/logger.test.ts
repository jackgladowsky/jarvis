import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadLoggerWithBrokenAuditPath() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-logger-test-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test prompt", "utf-8");
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      "agent: { provider: codex, model: gpt-5.1 }",
      "session: { inactivity_threshold_minutes: 60, max_duration_hours: 24, summarize_on_rotation: false, announce_new_session: false }",
      "compaction: { enabled: false, reserve_tokens: 1000, keep_recent_tokens: 100 }",
      "tools:",
      "  bash: { default_timeout_seconds: 30, max_timeout_seconds: 120 }",
      "telegram: { show_typing: false, long_tool_call_seconds: 5, parse_mode: none }",
      "stt:",
      "  provider: disabled",
      "  local_whisper_cpp: { whisper_binary_path: /tmp/whisper-cli, model_path: /tmp/model, ffmpeg_path: /usr/bin/ffmpeg, max_audio_mb: 25, timeout_seconds: 120 }",
      "scheduler: { enabled: false, timezone: UTC, telegram_chat_id: 0, tasks: [] }",
      "logging: { audit_log_enabled: true, audit_log_max_value_bytes: 2048, audit_log_redact_patterns: true, level: info }",
      "",
    ].join("\n"),
    "utf-8",
  );
  const auditPath = join(dataDir, "data", "audit.log");
  await mkdir(auditPath, { recursive: true });
  return { logger: await import("./logger.js"), auditPath };
}

test("audit I/O failure never rejects a completed tool and later writes recover", async () => {
  const { logger, auditPath } = await loadLoggerWithBrokenAuditPath();
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await assert.doesNotReject(() =>
      logger.auditToolCall({ tool: "write", args: { path: "/tmp/x" }, outcome: "ok", duration_ms: 1 }),
    );
  } finally {
    console.error = originalConsoleError;
  }

  await rm(auditPath, { recursive: true });
  await logger.auditToolCall({ tool: "read", args: { path: "/tmp/x" }, outcome: "ok", duration_ms: 1 });
  const line = JSON.parse((await readFile(auditPath, "utf-8")).trim()) as { tool: string };
  assert.equal(line.tool, "read");
});
