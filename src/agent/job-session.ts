// Persistent agent sessions for scheduled jobs and background workers.
//
// These are not user chat sessions: they are long-lived per-task transcripts.
// After compaction we rewrite the JSONL to the latest summary plus kept tail
// so recurring jobs do not grow without bound on disk.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { appendFile, mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname } from "path";

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
  const out = messages.slice();
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.role !== "assistant") break;
    const hasToolCall = (last.content ?? []).some(
      (c: { type: string }) => c.type === "toolCall",
    );
    if (!hasToolCall) break;
    out.pop();
  }
  return out;
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
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { tail: [] };
    throw err;
  }

  return loadJobSessionLines(raw.split("\n"));
}

export async function appendJobMessages(file: string, messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await appendFile(file, lines, "utf-8");
}

function makeCompactionLine(entry: JobCompactionEntry): StoredCompactionEntry {
  return {
    type: "compaction",
    timestamp: Date.now(),
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
  };
}

export async function appendJobCompactionEntry(
  file: string,
  entry: JobCompactionEntry,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(makeCompactionLine(entry)) + "\n", "utf-8");
}

export async function rewriteJobSessionWithCompaction(
  file: string,
  entry: JobCompactionEntry,
  keptTail: AgentMessage[],
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const lines = [
    JSON.stringify(makeCompactionLine(entry)),
    ...keptTail.map((message) => JSON.stringify(message)),
  ];
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, lines.join("\n") + "\n", "utf-8");
  await rename(tmp, file);
}
