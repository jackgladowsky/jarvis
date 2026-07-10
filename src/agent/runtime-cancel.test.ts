import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

async function prepareRuntime() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-runtime-cancel-test-"));
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

  return await import("./runtime.js");
}

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
} as Model<any>;

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function abortedAssistant(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "openai-completions",
    provider: "openrouter",
    model: "fake-model",
    usage: zeroUsage,
    stopReason: "aborted",
    errorMessage: "aborted",
    timestamp: 2,
  } as AgentMessage;
}

function assistantToolCall(id = "call_1"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command: "sleep 30" } }],
    api: "openai-completions",
    provider: "openrouter",
    model: "fake-model",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: 2,
  } as unknown as AgentMessage;
}

function toolResult(id = "call_1"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "done" }],
    details: {},
    isError: false,
    timestamp: 3,
  } as AgentMessage;
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

test("cancel normalization rewrites pi-agent aborted assistant into visible stopped marker", async () => {
  const runtime = await prepareRuntime();

  const normalized = runtime.normalizeCancelledChatMessages(
    [user("do work"), abortedAssistant()],
    fakeModel,
    "Stop tapped.",
  );

  assert.equal(normalized.length, 2);
  assert.equal((normalized[1] as { role: string }).role, "assistant");
  assert.equal((normalized[1] as { stopReason: string }).stopReason, "aborted");
  assert.equal((normalized[1] as { errorMessage: string }).errorMessage, "Stop tapped.");
  assert.equal(textOf(normalized[1]), runtime.STOPPED_BY_USER_TEXT);
});

test("cancel normalization drops dangling assistant tool call before stopped marker", async () => {
  const runtime = await prepareRuntime();

  const normalized = runtime.normalizeCancelledChatMessages([user("do work"), assistantToolCall()], fakeModel);

  assert.equal(normalized.length, 2);
  assert.equal((normalized[0] as { role: string }).role, "user");
  assert.equal((normalized[1] as { role: string }).role, "assistant");
  assert.equal((normalized[1] as { stopReason: string }).stopReason, "aborted");
  assert.equal(textOf(normalized[1]), runtime.STOPPED_BY_USER_TEXT);
});

test("cancel normalization preserves completed tool result before stopped marker", async () => {
  const runtime = await prepareRuntime();

  const normalized = runtime.normalizeCancelledChatMessages(
    [user("do work"), assistantToolCall(), toolResult()],
    fakeModel,
  );

  assert.equal(normalized.length, 4);
  assert.equal((normalized[1] as { role: string }).role, "assistant");
  assert.equal((normalized[2] as { role: string }).role, "toolResult");
  assert.equal((normalized[3] as { stopReason: string }).stopReason, "aborted");
  assert.equal(textOf(normalized[3]), runtime.STOPPED_BY_USER_TEXT);
});

test("retry classification is narrow and provider-aware", async () => {
  const runtime = await prepareRuntime();

  assert.equal(runtime.classifyAgentFailure("server_error: overloaded (503)"), "transient");
  assert.equal(runtime.classifyAgentFailure("fetch failed: ECONNRESET"), "transient");
  assert.equal(runtime.classifyAgentFailure("usage_limit_reached"), "provider_unavailable");
  assert.equal(runtime.classifyAgentFailure("invalid request: context too long"), "permanent");
});

test("inference replay stops at either tool or visible-output boundary", async () => {
  const runtime = await prepareRuntime();

  assert.equal(runtime.isInferenceReplaySafe({ toolStarted: false, visibleAssistantOutput: false }), true);
  assert.equal(runtime.isInferenceReplaySafe({ toolStarted: true, visibleAssistantOutput: false }), false);
  assert.equal(runtime.isInferenceReplaySafe({ toolStarted: false, visibleAssistantOutput: true }), false);
});

test("agent_end-only failure messages are detected", async () => {
  const runtime = await prepareRuntime();

  assert.equal(runtime.failureFromMessages([abortedAssistant()]), "aborted");
});
