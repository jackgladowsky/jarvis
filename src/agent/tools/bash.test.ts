import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadBashModule() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-bash-test-"));
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
      "logging: { audit_log_enabled: false, audit_log_max_value_bytes: 2048, audit_log_redact_patterns: true, level: info }",
      "",
    ].join("\n"),
    "utf-8",
  );
  return import("./bash.js");
}

test("bash output buffer retains bounded head and tail while counting discarded bytes", async () => {
  const { BoundedBashOutput, MAX_BASH_OUTPUT_BYTES } = await loadBashModule();
  const output = new BoundedBashOutput();
  output.push(Buffer.alloc(60_000, "a"));
  output.push(Buffer.alloc(250_000, "b"));
  output.push(Buffer.alloc(60_000, "c"));

  const result = output.finish();
  assert.equal(result.totalBytes, 370_000);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^a+/);
  assert.match(result.text, /c+$/);
  assert.match(result.text, /truncated 270000 bytes/);
  assert.ok(Buffer.byteLength(result.text) < MAX_BASH_OUTPUT_BYTES + 100);
});

test("bash tool bounds noisy process output before returning it", async () => {
  const { bashTool, MAX_BASH_OUTPUT_BYTES } = await loadBashModule();
  const result = await bashTool.execute("call-1", { command: "head -c 370000 /dev/zero | tr '\\0' x" }, undefined);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const details = result.details as { truncated: boolean; exit: number };

  assert.equal(details.exit, 0);
  assert.equal(details.truncated, true);
  assert.match(text, /truncated 270000 bytes/);
  assert.ok(Buffer.byteLength(text) < MAX_BASH_OUTPUT_BYTES + 250);
});
