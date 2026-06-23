import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  appendJobMessages,
  loadJobSession,
  loadJobSessionLines,
  rewriteJobSessionWithCompaction,
} from "./job-session.js";

function user(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: 2,
  } as AgentMessage;
}

function assistantToolCall(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/x" } }],
    timestamp: 3,
  } as unknown as AgentMessage;
}

test("loadJobSessionLines keeps only the latest compacted summary and tail", () => {
  const first = { type: "compaction", timestamp: 1, summary: "old", tokensBefore: 100 };
  const second = { type: "compaction", timestamp: 2, summary: "new", tokensBefore: 200 };
  const loaded = loadJobSessionLines([
    JSON.stringify(user("before")),
    JSON.stringify(first),
    JSON.stringify(user("discarded by newer compaction")),
    JSON.stringify(second),
    JSON.stringify(user("kept")),
    JSON.stringify(assistant("also kept")),
  ]);

  assert.equal(loaded.previousSummary, "new");
  assert.deepEqual(
    loaded.tail.map((m) => m.role),
    ["user", "assistant"],
  );
});

test("loadJobSessionLines drops dangling assistant tool calls", () => {
  const loaded = loadJobSessionLines([JSON.stringify(user("kept")), JSON.stringify(assistantToolCall())]);

  assert.deepEqual(
    loaded.tail.map((m) => m.role),
    ["user"],
  );
});

test("rewriteJobSessionWithCompaction bounds the transcript to summary plus kept tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-job-session-"));
  try {
    const file = join(dir, "task.jsonl");
    await appendJobMessages(file, [user("old 1"), assistant("old 2"), user("keep")]);

    await rewriteJobSessionWithCompaction(file, { summary: "summary", tokensBefore: 123 }, [user("keep")]);

    const raw = await readFile(file, "utf-8");
    const lines = raw.trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).type, "compaction");
    assert.equal(JSON.parse(lines[0]).summary, "summary");

    const loaded = await loadJobSession(file);
    assert.equal(loaded.previousSummary, "summary");
    assert.deepEqual(
      loaded.tail.map((m) => (m.content as Array<{ text?: string }>)[0]?.text),
      ["keep"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
