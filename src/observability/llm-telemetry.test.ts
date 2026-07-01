import test from "node:test";
import assert from "node:assert/strict";
import type { Context, Model } from "@mariozechner/pi-ai";
import { buildStartedEvent, hashTelemetryIdentifier, redactTelemetryText } from "./llm-telemetry.js";

const model: Model<any> = {
  id: "openai/gpt-test",
  name: "GPT Test",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
};

const context: Context = {
  systemPrompt: "secret-ish system prompt",
  messages: [{ role: "user", content: [{ type: "text", text: "hello sk-abcdefghijklmnopqrstuvwxyz" }], timestamp: 1 }],
  tools: [{ name: "read", description: "read", parameters: { type: "object" } as any }],
};

test("metadata telemetry start events keep prompt content out by default", () => {
  const event = buildStartedEvent(model, context, { maxTokens: 123 }, { kind: "chat", session_id: "s1" }, { call_id: "c1", trace_id: "t1", span_id: "s1" });
  assert.equal(event.event_type, "llm.call.started");
  assert.equal(event.request?.model, "openai/gpt-test");
  assert.equal(event.request?.message_count, 1);
  assert.equal(event.request?.tool_count, 1);
  assert.equal(typeof event.request?.input_sha256, "string");
  assert.equal(event.request?.input_preview, undefined);
  assert.equal(event.request?.raw_payload, undefined);
  assert.equal(JSON.stringify(event).includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("telemetry redacts obvious secrets and hashes identifiers", () => {
  const redacted = redactTelemetryText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789");
  assert.equal(redacted.redacted, true);
  assert.match(redacted.text, /\[REDACTED\]/);
  assert.equal(hashTelemetryIdentifier(123), hashTelemetryIdentifier(123));
  assert.notEqual(hashTelemetryIdentifier(123), hashTelemetryIdentifier(456));
});
