import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import { Type } from "typebox";

let loaded: Promise<typeof import("./context-budget.js")> | undefined;
async function moduleUnderTest() {
  if (loaded) return loaded;
  const data = await mkdtemp(join(tmpdir(), "jarvis-budget-"));
  process.env.JARVIS_DATA_DIR = data;
  process.env.TELEGRAM_BOT_TOKEN = "test";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.EXA_API_KEY = "test";
  await mkdir(join(data, "prompts"), { recursive: true });
  await writeFile(join(data, "prompts", "system.md"), "test");
  await writeFile(
    join(data, "config.yaml"),
    [
      "agent: { provider: codex, model: gpt-5.1 }",
      "session: { inactivity_threshold_minutes: 60, max_duration_hours: 24, summarize_on_rotation: false, announce_new_session: false }",
      "compaction: { enabled: true, reserve_tokens: 2000, keep_recent_tokens: 100 }",
      "tools: { bash: { default_timeout_seconds: 30, max_timeout_seconds: 60 } }",
      "telegram: { show_typing: false, long_tool_call_seconds: 5, parse_mode: none }",
      "stt: { provider: disabled, local_whisper_cpp: { whisper_binary_path: /tmp/w, model_path: /tmp/m, ffmpeg_path: null, max_audio_mb: 1, timeout_seconds: 1 } }",
      "scheduler: { enabled: false, timezone: UTC, telegram_chat_id: 0, tasks: [] }",
      "logging: { audit_log_enabled: false, audit_log_max_value_bytes: 2048, audit_log_redact_patterns: true, level: info }",
    ].join("\n"),
  );
  loaded = import("./context-budget.js");
  return loaded;
}

const model = {
  id: "budget-model",
  provider: "openrouter",
  api: "openai-completions",
  contextWindow: 12_000,
  maxTokens: 2_000,
} as Model<any>;

const tool = {
  name: "read",
  label: "read",
  description: "read data",
  parameters: Type.Object({ path: Type.String() }),
  async execute() {
    return { content: [{ type: "text" as const, text: "ok" }], details: {} };
  },
} satisfies AgentTool<any>;

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

test("context plan includes system, schemas, current input, images, and output reserve", async () => {
  const { planContext } = await moduleUnderTest();
  const image = {
    type: "image",
    mimeType: "image/jpeg",
    data: Buffer.alloc(700_000).toString("base64"),
  } as ImageContent;
  const plan = planContext({
    model,
    systemPrompt: "system".repeat(100),
    tools: [tool],
    history: [user("history".repeat(100))],
    currentText: "current".repeat(100),
    currentImages: [image],
  });
  assert.ok(plan.breakdown.system > 0);
  assert.ok(plan.breakdown.tools > 0);
  assert.ok(plan.breakdown.currentInput > 0);
  assert.ok(plan.breakdown.images >= 1_100);
  assert.equal(plan.breakdown.outputReserve, 2_000);
  assert.equal(
    plan.breakdown.totalInput,
    plan.breakdown.system +
      plan.breakdown.tools +
      plan.breakdown.history +
      plan.breakdown.currentInput +
      plan.breakdown.images +
      plan.breakdown.framing,
  );
});

test("provider-carried reasoning and tool signatures count toward history", async () => {
  const { estimateMessageTokens } = await moduleUnderTest();
  const unsigned = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "toolCall", id: "c", name: "read", arguments: {} },
    ],
    timestamp: 1,
  } as unknown as AgentMessage;
  const signed = {
    ...unsigned,
    content: [
      { type: "thinking", thinking: "", redacted: true, thinkingSignature: "e".repeat(12_000) },
      { type: "toolCall", id: "c", name: "read", arguments: {}, thoughtSignature: "s".repeat(6_000) },
    ],
  } as unknown as AgentMessage;
  assert.ok(estimateMessageTokens(signed, model) > estimateMessageTokens(unsigned, model) + 5_000);
});

test("reserve stays fixed when model maxTokens is much larger", async () => {
  const { planContext } = await moduleUnderTest();
  const largeOutputModel = { ...model, contextWindow: 20_000, maxTokens: 128_000 } as Model<any>;
  const plan = planContext({ model: largeOutputModel, systemPrompt: "s", tools: [], history: [] });
  assert.equal(plan.breakdown.outputReserve, 2_000);
  assert.equal(plan.breakdown.inputCeiling, 20_000 - 2_000 - plan.breakdown.toolLoopReserve);
});

test("context plan rejects an unfit current input instead of relying on compaction", async () => {
  const { planContext } = await moduleUnderTest();
  const tiny = { ...model, contextWindow: 4_000, maxTokens: 1_024 } as Model<any>;
  const plan = planContext({
    model: tiny,
    systemPrompt: "s",
    tools: [tool],
    history: [],
    currentText: "x".repeat(20_000),
  });
  assert.equal(plan.decision, "impossible");
  assert.match(plan.reason ?? "", /fixed request envelope/);
});
