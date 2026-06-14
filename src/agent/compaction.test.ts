import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

async function loadCompactionModule() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-compaction-test-"));
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
    "  telegram_chat_id: 0",
    "  tasks: []",
    "logging:",
    "  audit_log_enabled: false",
    "  audit_log_max_value_bytes: 2048",
    "  audit_log_redact_patterns: true",
    "  level: info",
    "",
  ].join("\n"), "utf-8");
  return import("./compaction.js");
}

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as AgentMessage;
}

function toolResult(text: string): AgentMessage {
  return { role: "toolResult", content: [{ type: "text", text }], timestamp: 3 } as AgentMessage;
}

test("estimateMessageTokens handles user, assistant, tool, and image-ish content", async () => {
  const { estimateMessageTokens, estimateContextTokens } = await loadCompactionModule();

  assert.equal(estimateMessageTokens(user("abcd")), 1);
  assert.equal(estimateMessageTokens(assistant("abcdefgh")), 2);
  assert.equal(estimateMessageTokens(toolResult("abcdef")), 2);
  assert.equal(estimateContextTokens([user("abcd"), assistant("abcdefgh")]), 3);
});

test("findCutPoint keeps recent messages starting at a user boundary", async () => {
  const { findCutPoint } = await loadCompactionModule();
  const messages = [user("old"), assistant("old reply"), toolResult("tool output"), user("recent ask"), assistant("recent reply")];

  assert.equal(findCutPoint(messages, 4), 3);
  assert.equal(findCutPoint(messages, 10_000), 0);
  assert.equal(findCutPoint([], 10), 0);
});

test("shouldCompact respects disabled/invalid windows and configured reserve", async () => {
  const { shouldCompact } = await loadCompactionModule();

  assert.equal(shouldCompact(901, 1000), true);
  assert.equal(shouldCompact(900, 1000), false);
  assert.equal(shouldCompact(1000, 0), false);
});
