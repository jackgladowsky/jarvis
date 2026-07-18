import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage, type AfterToolCallContext } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, Type } from "@mariozechner/pi-ai";

async function loadModule() {
  const data = await mkdtemp(join(tmpdir(), "jarvis-tool-budget-"));
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
  return import("./tool-result-budget.js");
}

const model = {
  id: "tiny",
  provider: "openrouter",
  api: "openai-completions",
  contextWindow: 8_000,
  maxTokens: 2_000,
} as Model<any>;

function context(history: AgentMessage[], resultText: string, assistantMessage: object = {}): AfterToolCallContext {
  return {
    assistantMessage: assistantMessage as never,
    toolCall: { id: "call", name: "read", type: "toolCall", arguments: {} },
    args: {},
    isError: false,
    context: { systemPrompt: "system".repeat(100), messages: history, tools: [] },
    result: { content: [{ type: "text", text: resultText }], details: {} },
  };
}

function resultText(result: ReturnType<(typeof import("./tool-result-budget.js"))["budgetToolResult"]>): string {
  const first = result?.content?.[0];
  return first?.type === "text" ? first.text : "";
}

test("runtime tool-result cap preserves response/tool-loop headroom across repeated reads", async () => {
  const { budgetToolResult } = await loadModule();
  const history = [
    { role: "user", content: [{ type: "text", text: "h".repeat(7_000) }], timestamp: 1 },
  ] as AgentMessage[];
  const first = budgetToolResult(context(history, "x".repeat(1_000_000)), { model });
  assert.ok(first);
  const firstText = resultText(first);
  assert.match(firstText, /truncated by context budget|context budget exhausted/);
  assert.ok(Buffer.byteLength(firstText) < 64 * 1024);

  const prior = {
    role: "toolResult",
    toolCallId: "old",
    toolName: "read",
    content: first?.content ?? [],
    details: {},
    isError: false,
    timestamp: 2,
  } as AgentMessage;
  const second = budgetToolResult(context([...history, prior], "y".repeat(1_000_000)), { model });
  assert.ok(second);
  assert.ok(Buffer.byteLength(resultText(second)) <= Buffer.byteLength(firstText));
});

test("same assistant multi-tool batch shares one aggregate result grant", async () => {
  const { createToolResultBudgeter } = await loadModule();
  const history = [
    { role: "user", content: [{ type: "text", text: "h".repeat(7_000) }], timestamp: 1 },
  ] as AgentMessage[];
  const assistantMessage = {};
  const budget = createToolResultBudgeter(model);
  const first = await budget(context(history, "x".repeat(1_000_000), assistantMessage));
  const second = await budget(context(history, "y".repeat(1_000_000), assistantMessage));
  assert.ok(first && second);
  assert.match(resultText(second), /context budget exhausted/);
  assert.notEqual(second.terminate, true);
  assert.ok(Buffer.byteLength(resultText(first)) + Buffer.byteLength(resultText(second)) < 64 * 1024);
});

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function messageStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push(
      message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : { type: "done", reason: message.stopReason, message },
    );
  });
  return stream;
}

test("an exhausted single tool result gets one tool-free continuation and a final answer", async () => {
  const { createToolResultBudgeter } = await loadModule();
  const budgeter = createToolResultBudgeter(model);
  let providerCalls = 0;
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: "system",
      tools: [
        {
          name: "huge",
          label: "Huge",
          description: "Return a huge result",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text" as const, text: "x".repeat(1_000_000) }], details: {} }),
        },
      ],
    },
    afterToolCall: budgeter,
    streamFn: (_streamModel, providerContext) => {
      providerCalls += 1;
      const constrained = budgeter.constrainProviderContext(providerContext);
      if (providerCalls === 1) {
        assert.equal(constrained.tools?.length, 1);
        return messageStream(
          assistant([{ type: "toolCall", id: "call-1", name: "huge", arguments: {} }], "toolUse"),
        ) as never;
      }
      assert.deepEqual(constrained.tools, []);
      return messageStream(
        assistant([{ type: "text", text: "I couldn't include the huge result, but here's the answer." }], "stop"),
      ) as never;
    },
  });

  // Leave no result allowance, forcing the omission-marker path.
  await agent.prompt("h".repeat(30_000));

  assert.equal(providerCalls, 2);
  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.match(
    final?.role === "assistant" && final.content[0]?.type === "text" ? final.content[0].text : "",
    /here's the answer/,
  );
});
