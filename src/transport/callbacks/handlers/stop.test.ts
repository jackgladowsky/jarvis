import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "grammy";

async function prepareRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-stop-callback-test-"));
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

  const { activeAgentRuns } = await import("../../../agent/run-registry.js");
  const state = await import("../../commands/handlers/state.js");
  const stop = await import("./stop.js");
  return { activeAgentRuns, state, stop };
}

function fakeCtx(chatId: number, calls: string[]): Context {
  return {
    chat: { id: chatId },
    answerCallbackQuery: async (payload: { text?: string }) => {
      calls.push(`answer:${payload.text ?? ""}`);
      return true;
    },
    editMessageText: async (text: string) => {
      calls.push(`editText:${text}`);
      return true;
    },
    editMessageReplyMarkup: async () => {
      calls.push("editMarkup");
      return true;
    },
  } as unknown as Context;
}

test("Stop callback aborts active chat run and updates button message immediately", async () => {
  const { activeAgentRuns, state, stop } = await prepareRuntime();
  const run = activeAgentRuns.start("chat", 777);
  state.setStopButtonMessage(777, 42);
  const calls: string[] = [];

  await stop.handleStop(fakeCtx(777, calls), "stop");

  assert.equal(run.signal.aborted, true);
  assert.equal(state.getStopButtonMessage(777), undefined);
  assert.deepEqual(calls, ["answer:Stopping…", "editText:⏹ Stopping…"]);
  run.finish();
});

test("Stop callback handles stale taps without claiming cancellation", async () => {
  const { state, stop } = await prepareRuntime();
  state.setStopButtonMessage(778, 42);
  const calls: string[] = [];

  await stop.handleStop(fakeCtx(778, calls), "stop");

  assert.equal(state.getStopButtonMessage(778), undefined);
  assert.deepEqual(calls, ["answer:Already finished.", "editMarkup"]);
});
