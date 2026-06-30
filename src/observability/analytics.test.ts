import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectObservabilitySummary, type SourceRoot } from "./analytics.js";

test("collectObservabilitySummary aggregates sessions, usage, tools, model switches, and pi traces", async () => {
  const base = await mkdtemp(join(tmpdir(), "jarvis-observability-"));
  const chat = join(base, "sessions");
  const jobs = join(base, "jobs");
  const pi = join(base, "pi");
  await mkdir(join(chat, "archive"), { recursive: true });
  await mkdir(jobs, { recursive: true });
  await mkdir(pi, { recursive: true });

  await writeFile(
    join(chat, "archive", "a.jsonl"),
    [
      JSON.stringify({ role: "user", timestamp: Date.UTC(2026, 0, 1), content: [{ type: "text", text: "hello" }] }),
      JSON.stringify({
        role: "assistant",
        timestamp: Date.UTC(2026, 0, 1, 0, 1),
        provider: "openrouter",
        model: "model-a",
        api: "openai-completions",
        stopReason: "toolUse",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.01 } },
        content: [{ type: "toolCall", name: "bash", id: "1", arguments: {} }],
      }),
      JSON.stringify({
        role: "assistant",
        timestamp: Date.UTC(2026, 0, 1, 0, 2),
        provider: "fallback-provider",
        model: "model-b",
        usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.02 } },
        content: [{ type: "text", text: "fallback worked" }],
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
  await writeFile(
    join(jobs, "job.jsonl"),
    JSON.stringify({ type: "compaction", timestamp: Date.UTC(2026, 0, 2), summary: "old", tokensBefore: 100 }) + "\n",
    "utf-8",
  );
  await writeFile(
    join(pi, "pi.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pi-session",
        timestamp: "2026-01-03T00:00:00.000Z",
        cwd: "/repo",
      }),
      JSON.stringify({
        type: "session_info",
        id: "info",
        parentId: null,
        timestamp: "2026-01-03T00:00:01.000Z",
        name: "Pi trace",
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-03T00:00:02.000Z",
        message: { role: "user", content: "inspect pi" },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-03T00:00:03.000Z",
        message: {
          role: "assistant",
          provider: "openrouter",
          model: "pi-model",
          api: "openai-responses",
          stopReason: "toolUse",
          usage: { input: 8, output: 2, totalTokens: 10, cost: { total: 0.04 } },
          content: [{ type: "toolCall", name: "read", id: "t1", arguments: {} }],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "t1r",
        parentId: "a1",
        timestamp: "2026-01-03T00:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "failed" }],
        },
      }),
      JSON.stringify({
        type: "compaction",
        id: "c1",
        parentId: "t1r",
        timestamp: "2026-01-03T00:00:05.000Z",
        summary: "old",
        firstKeptEntryId: "a1",
        tokensBefore: 100,
      }),
    ].join("\n") + "\n",
    "utf-8",
  );

  const roots: SourceRoot[] = [
    { source: "chat", root: chat },
    { source: "scheduled", root: jobs },
    { source: "pi", root: pi },
  ];
  const summary = await collectObservabilitySummary(roots);

  assert.equal(summary.scannedFiles, 3);
  assert.equal(summary.totals.sessions, 3);
  assert.equal(summary.totals.usage.requests, 3);
  assert.equal(summary.totals.usage.tokens.total, 34);
  assert.ok(Math.abs(summary.totals.usage.cost.total - 0.07) < 0.000001);
  assert.equal(summary.toolUsage[0]?.name, "bash");
  assert.equal(summary.toolUsage[0]?.calls, 1);
  assert.deepEqual(summary.byModel.map((row) => row.key).sort(), ["model-a", "model-b", "pi-model"]);
  assert.equal(
    summary.byModel.reduce((total, row) => total + row.tokens.total, 0),
    summary.totals.usage.tokens.total,
  );
  assert.ok(
    Math.abs(summary.byModel.reduce((total, row) => total + row.cost.total, 0) - summary.totals.usage.cost.total) <
      0.000001,
  );
  assert.equal(
    summary.byProvider.reduce((total, row) => total + row.tokens.total, 0),
    summary.totals.usage.tokens.total,
  );
  assert.ok(
    Math.abs(summary.byProvider.reduce((total, row) => total + row.cost.total, 0) - summary.totals.usage.cost.total) <
      0.000001,
  );
  assert.equal(summary.sessions.find((session) => session.id === "job")?.compactions, 1);
  assert.equal(summary.sessions.find((session) => session.id === "pi")?.source, "pi");
  assert.equal(summary.sessions.find((session) => session.id === "pi")?.displayName, "Pi trace");
  const piSession = summary.sessions.find((session) => session.id === "pi");
  assert.equal(piSession?.toolResults, 1);
  assert.equal(piSession?.toolErrors, 1);
  assert.equal(piSession?.toolUsage.find((tool) => tool.name === "read")?.errors, 1);
  assert.equal(piSession?.toolUsage.find((tool) => tool.name === "read")?.sessions, 1);
  assert.ok(piSession?.traceNodes.some((node) => node.kind === "tool_call" && node.toolName === "read"));
  assert.ok(piSession?.traceNodes.some((node) => node.kind === "tool_result" && node.isError === true));
  assert.ok((piSession?.maxInterEventGapMs ?? 0) > 0);
  assert.ok((piSession?.attentionScore ?? 0) > 0);
  assert.equal(summary.totals.toolErrors, 1);
  assert.ok(summary.timeSeries.some((bucket) => bucket.toolErrors === 1));
  assert.equal(summary.sessions.find((session) => session.id === "a")?.classification.status, "unclassified");
  assert.ok(summary.retryFallbackEvents.some((event) => event.type === "model_switch"));
  assert.ok(summary.retryFallbackEvents.some((event) => event.type === "tool_error"));
});
