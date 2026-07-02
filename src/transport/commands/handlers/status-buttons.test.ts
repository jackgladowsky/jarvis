import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";

async function prepareRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-status-buttons-test-"));
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
      "  enabled: false",
      "  reserve_tokens: 1000",
      "  keep_recent_tokens: 100",
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

  return import("./status.js");
}

function fakeReplyCtx(chatId: number, replies: Array<{ text: string; options?: { reply_markup?: unknown } }>): Context {
  return {
    chat: { id: chatId },
    reply: async (text: string, options?: { reply_markup?: unknown }) => {
      replies.push({ text, options });
      return true;
    },
  } as unknown as Context;
}

test("no-arg /reasoning replies with text only", async () => {
  const status = await prepareRuntime();
  const replies: Array<{ text: string; options?: { reply_markup?: unknown } }> = [];

  await status.handleReasoning(fakeReplyCtx(123, replies), {
    args: "",
    parts: [],
    name: "reasoning",
    raw: "/reasoning",
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^Reasoning: /);
  assert.equal(replies[0].options?.reply_markup, undefined);
});

test("no-arg /thinking replies with text only", async () => {
  const status = await prepareRuntime();
  const replies: Array<{ text: string; options?: { reply_markup?: unknown } }> = [];

  await status.handleThinkingOrVerbose(fakeReplyCtx(123, replies), {
    args: "",
    parts: [],
    name: "thinking",
    raw: "/thinking",
  });

  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^Progress updates: /);
  assert.equal(replies[0].options?.reply_markup, undefined);
});
