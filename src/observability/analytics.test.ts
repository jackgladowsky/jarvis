import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectObservabilitySummary, type SourceRoot } from "./analytics.js";

test("collectObservabilitySummary aggregates sessions, usage, tools, and model switches", async () => {
  const base = await mkdtemp(join(tmpdir(), "jarvis-observability-"));
  const chat = join(base, "sessions");
  const jobs = join(base, "jobs");
  await mkdir(join(chat, "archive"), { recursive: true });
  await mkdir(jobs, { recursive: true });

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

  const roots: SourceRoot[] = [
    { source: "chat", root: chat },
    { source: "scheduled", root: jobs },
  ];
  const summary = await collectObservabilitySummary(roots);

  assert.equal(summary.scannedFiles, 2);
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.totals.usage.requests, 2);
  assert.equal(summary.totals.usage.tokens.total, 24);
  assert.equal(summary.totals.usage.cost.total, 0.03);
  assert.equal(summary.toolUsage[0]?.name, "bash");
  assert.equal(summary.toolUsage[0]?.calls, 1);
  assert.deepEqual(summary.byModel.map((row) => row.key).sort(), ["model-a", "model-b"]);
  assert.equal(
    summary.byModel.reduce((total, row) => total + row.tokens.total, 0),
    summary.totals.usage.tokens.total,
  );
  assert.equal(
    summary.byModel.reduce((total, row) => total + row.cost.total, 0),
    summary.totals.usage.cost.total,
  );
  assert.equal(
    summary.byProvider.reduce((total, row) => total + row.tokens.total, 0),
    summary.totals.usage.tokens.total,
  );
  assert.equal(
    summary.byProvider.reduce((total, row) => total + row.cost.total, 0),
    summary.totals.usage.cost.total,
  );
  assert.equal(summary.sessions.find((session) => session.id === "job")?.compactions, 1);
  assert.equal(summary.sessions.find((session) => session.id === "a")?.classification.status, "unclassified");
  assert.ok(summary.retryFallbackEvents.some((event) => event.type === "model_switch"));
});
