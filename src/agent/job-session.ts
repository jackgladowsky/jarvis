// Persistent agent sessions for scheduled jobs and background workers.
//
// These are not user chat sessions: they are long-lived per-task transcripts.
// After compaction we rewrite the JSONL to the latest summary plus kept tail
// so recurring jobs do not grow without bound on disk.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile, withFileLock } from "../lib/durable-file.js";
import { appendJsonLinesDurable, readJsonLinesRecovering } from "../lib/json-lines.js";

export interface JobLoadedSession {
  previousSummary?: string;
  tail: AgentMessage[];
}

export interface JobCompactionEntry {
  summary: string;
  tokensBefore: number;
}

interface StoredCompactionEntry extends JobCompactionEntry {
  type: "compaction";
  timestamp: number;
}

export function isJobCompactionEntry(parsed: unknown): parsed is StoredCompactionEntry {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: string }).type === "compaction" &&
    typeof (parsed as { summary?: unknown }).summary === "string"
  );
}

export function dropDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const callIds = ((message.content ?? []) as Array<{ type: string; id?: unknown }>)
      .filter((item) => item.type === "toolCall" && typeof item.id === "string")
      .map((item) => item.id as string);
    if (callIds.length === 0) continue;

    const pending = new Set(callIds);
    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex += 1) {
      const result = messages[resultIndex];
      if (result.role !== "toolResult") break;
      pending.delete((result as { toolCallId?: string }).toolCallId ?? "");
    }
    if (pending.size > 0) return messages.slice(0, index);
  }
  return messages.slice();
}

export function loadJobSessionLines(lines: string[]): JobLoadedSession {
  let previousSummary: string | undefined;
  let tail: AgentMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    if (isJobCompactionEntry(parsed)) {
      previousSummary = parsed.summary;
      tail = [];
    } else {
      tail.push(parsed as AgentMessage);
    }
  }

  return { previousSummary, tail: dropDanglingToolCalls(tail) };
}

export async function loadJobSession(file: string): Promise<JobLoadedSession> {
  const records = await readJsonLinesRecovering<unknown>(file);
  return loadJobSessionLines(records.map((record) => JSON.stringify(record)));
}

export async function appendJobMessages(file: string, messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await appendJsonLinesDurable(file, lines);
}

function makeCompactionLine(entry: JobCompactionEntry): StoredCompactionEntry {
  return {
    type: "compaction",
    timestamp: Date.now(),
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
  };
}

export async function appendJobCompactionEntry(file: string, entry: JobCompactionEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendJsonLinesDurable(file, JSON.stringify(makeCompactionLine(entry)) + "\n");
}

export async function rewriteJobSessionWithCompaction(
  file: string,
  entry: JobCompactionEntry,
  keptTail: AgentMessage[],
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const lines = [JSON.stringify(makeCompactionLine(entry)), ...keptTail.map((message) => JSON.stringify(message))];
  await withFileLock(file, () => atomicWriteFile(file, lines.join("\n") + "\n"));
}
