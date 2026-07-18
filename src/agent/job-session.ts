// Persistent append-only sessions for scheduled jobs and background workers.
// Compaction checkpoints are derived views with canonical message references;
// source messages are never rewritten or deleted by current versions.

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { appendJsonLinesDurable, readJsonLinesRecovering } from "../lib/json-lines.js";

export interface JobLoadedSession {
  previousSummary?: string;
  tail: AgentMessage[];
  tailSourceIndexes: number[];
  sourceMessageCount: number;
}

export interface JobCompactionEntry {
  summary: string;
  tokensBefore: number;
  keepFromMessage: number;
  sourceThroughMessage: number;
}

interface StoredCompactionEntry {
  type: "compaction";
  timestamp: number;
  summary: string;
  tokensBefore: number;
  version?: 2;
  checkpointId?: string;
  keepFromMessage?: number;
  sourceThroughMessage?: number;
}

export function isJobCompactionEntry(parsed: unknown): parsed is StoredCompactionEntry {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { type?: string }).type !== "compaction" ||
    typeof (parsed as { summary?: unknown }).summary !== "string"
  ) {
    return false;
  }
  const entry = parsed as Partial<StoredCompactionEntry>;
  if (entry.version !== 2) return true;
  return (
    typeof entry.checkpointId === "string" &&
    Number.isSafeInteger(entry.keepFromMessage) &&
    Number.isSafeInteger(entry.sourceThroughMessage) &&
    (entry.keepFromMessage ?? -1) >= 0 &&
    (entry.sourceThroughMessage ?? -1) >= (entry.keepFromMessage ?? 0)
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

export function loadJobSessionRecords(records: unknown[]): JobLoadedSession {
  const messages: Array<{ message: AgentMessage; sourceIndex: number; recordIndex: number }> = [];
  let sourceMessageCount = 0;
  let previousSummary: string | undefined;
  let legacyBarrier = -1;
  let keepFromMessage: number | undefined;
  for (const [recordIndex, parsed] of records.entries()) {
    if (isJobCompactionEntry(parsed)) {
      previousSummary = parsed.summary;
      if (parsed.version === 2 && typeof parsed.keepFromMessage === "number") {
        keepFromMessage = parsed.keepFromMessage;
      } else {
        legacyBarrier = recordIndex;
        keepFromMessage = undefined;
      }
    } else if (
      parsed &&
      typeof parsed === "object" &&
      ["user", "assistant", "toolResult"].includes(String((parsed as { role?: unknown }).role))
    ) {
      messages.push({ message: parsed as AgentMessage, sourceIndex: sourceMessageCount++, recordIndex });
    } else {
      throw new SyntaxError(`invalid job session JSONL record at line ${recordIndex + 1}`);
    }
  }
  const selected = messages.filter((entry) =>
    keepFromMessage !== undefined ? entry.sourceIndex >= keepFromMessage : entry.recordIndex > legacyBarrier,
  );
  const tail = dropDanglingToolCalls(selected.map((entry) => entry.message));
  return {
    previousSummary,
    tail,
    tailSourceIndexes: selected.slice(0, tail.length).map((entry) => entry.sourceIndex),
    sourceMessageCount,
  };
}

export function loadJobSessionLines(lines: string[]): JobLoadedSession {
  return loadJobSessionRecords(lines.filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown));
}

export async function loadJobSession(file: string): Promise<JobLoadedSession> {
  return loadJobSessionRecords(await readJsonLinesRecovering<unknown>(file));
}

export async function appendJobMessages(file: string, messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  await appendJsonLinesDurable(file, messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
}

export async function appendJobCompactionEntry(file: string, entry: JobCompactionEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const stored: StoredCompactionEntry = {
    type: "compaction",
    version: 2,
    checkpointId: randomUUID(),
    timestamp: Date.now(),
    ...entry,
  };
  await appendJsonLinesDurable(file, `${JSON.stringify(stored)}\n`);
}
