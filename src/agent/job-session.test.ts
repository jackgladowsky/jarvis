import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { appendJobCompactionEntry, appendJobMessages, loadJobSession, loadJobSessionLines } from "./job-session.js";

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

function assistantMultiToolCall(): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/x" } },
      { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/tmp/y" } },
    ],
    timestamp: 3,
  } as unknown as AgentMessage;
}

function toolResult(id: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "done" }],
    details: {},
    isError: false,
    timestamp: 4,
  } as AgentMessage;
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

test("loadJobSessionLines drops a multi-tool suffix when any result is missing", () => {
  const loaded = loadJobSessionLines([
    JSON.stringify(user("kept")),
    JSON.stringify(assistantMultiToolCall()),
    JSON.stringify(toolResult("call-1")),
  ]);

  assert.deepEqual(loaded.tail, [user("kept")]);
});

test("append-only job compaction preserves canonical source and derives kept tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-job-session-"));
  try {
    const file = join(dir, "task.jsonl");
    await appendJobMessages(file, [user("old 1"), assistant("old 2"), user("keep")]);

    await appendJobCompactionEntry(file, {
      summary: "summary",
      tokensBefore: 123,
      keepFromMessage: 2,
      sourceThroughMessage: 2,
    });

    const raw = await readFile(file, "utf-8");
    const lines = raw.trimEnd().split("\n");
    assert.equal(lines.length, 4);
    assert.equal((JSON.parse(lines[3]) as { type: string }).type, "compaction");
    assert.match(raw, /old 1/);
    assert.match(raw, /old 2/);

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

test("loadJobSession recovers a crash-truncated final JSONL record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-job-session-partial-"));
  try {
    const file = join(dir, "task.jsonl");
    await writeFile(file, `${JSON.stringify(user("kept"))}\n{"role":"assistant","content":`, "utf-8");

    const loaded = await loadJobSession(file);
    assert.deepEqual(loaded.tail, [user("kept")]);
    assert.equal(await readFile(file, "utf-8"), `${JSON.stringify(user("kept"))}\n`);
    assert.ok((await readdir(dir)).some((entry) => entry.startsWith("task.jsonl.corrupt-")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
