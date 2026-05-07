// Per-chat session bookkeeping for JARVIS — DESIGN.md §10.
//
// One session per chat at a time, persisted as `<sessionId>.jsonl` (one
// AgentMessage per line). The chat→session mapping lives in `active.json`,
// alongside startedAt and lastMessageAt timestamps used by the rotation rules:
//
//   - inactivity   (now - lastMessageAt > config.session.inactivity_threshold_minutes)
//   - max duration (now - startedAt      > config.session.max_duration_hours)
//   - manual       (`/new` from the transport)
//
// On rotation, the old session's JSONL moves to `archive/` and a fresh
// session takes over. Phase 5 will hook the summarizer into rotation to
// append a `recent.md` entry; Stage B of Phase 4 will add compaction. For
// now the rotation path is just file ops.
//
// The runtime treats sessions as stateless — for each prompt it reads the
// JSONL, builds an Agent with those messages, runs the loop, then appends
// any new messages produced. No long-lived in-memory Agent map.

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

// Per-chat metadata stored in active.json. Keyed by chat id (stringified, since
// JSON object keys are always strings).
interface ActiveSessionEntry {
  sessionId: string;
  startedAt: number;       // ms epoch
  lastMessageAt: number;   // ms epoch
}

type ActiveSessions = Record<string, ActiveSessionEntry>;

// In-memory mirror of active.json. Loaded once at startup, written through
// on every change.
let active: ActiveSessions = {};

// Format: YYYY-MM-DD_HHMM_<4 hex chars> — date-prefixed for grep-friendliness,
// hash suffix to disambiguate same-minute starts. (DESIGN.md open question #2.)
function newSessionId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const hash = randomBytes(2).toString("hex");
  return `${date}_${time}_${hash}`;
}

function sessionFile(id: string): string {
  return join(paths.sessions, `${id}.jsonl`);
}

function archivedSessionFile(id: string): string {
  return join(paths.sessionsArchive, `${id}.jsonl`);
}

// Shared parser used by both `load` (active session) and `loadArchived`
// (already-rotated session). Walks forward applying compaction entries.
async function loadFile(filePath: string): Promise<LoadedSession> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { tail: [] };
    }
    throw err;
  }

  let previousSummary: string | undefined;
  let tail: AgentMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    if (isCompactionEntry(parsed)) {
      previousSummary = parsed.summary;
      tail = []; // everything before this is now folded into the summary
    } else {
      tail.push(parsed as AgentMessage);
    }
  }

  return { previousSummary, tail: dropDanglingToolCalls(tail) };
}

async function loadActive(): Promise<void> {
  try {
    const raw = await readFile(paths.activeSessions, "utf-8");
    active = JSON.parse(raw) as ActiveSessions;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      active = {};
      return;
    }
    throw err;
  }
}

async function persistActive(): Promise<void> {
  await writeFile(paths.activeSessions, JSON.stringify(active, null, 2), "utf-8");
}

async function archive(sessionId: string): Promise<void> {
  const src = sessionFile(sessionId);
  const dst = archivedSessionFile(sessionId);
  try {
    await rename(src, dst);
  } catch (err: unknown) {
    // Nothing to archive (e.g. session existed in active.json but JSONL was
    // never written because no message succeeded). Treat as benign.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function isStale(entry: ActiveSessionEntry, now: number): boolean {
  const inactivityMs = config.session.inactivity_threshold_minutes * 60 * 1000;
  const maxDurationMs = config.session.max_duration_hours * 60 * 60 * 1000;
  if (now - entry.lastMessageAt > inactivityMs) return true;
  if (now - entry.startedAt > maxDurationMs) return true;
  return false;
}

// Result of resolveSession. `rotatedFrom` is set when an old session was
// archived as part of this resolution — Phase 5's summarizer will use that
// hook to append the rotated session's TOC entry to recent.md.
export interface ResolvedSession {
  sessionId: string;
  isNew: boolean;
  rotatedFrom?: string;
}

// Initialize at process startup. Creates the data dirs if missing and loads
// active.json into memory.
export async function init(): Promise<void> {
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.sessionsArchive, { recursive: true });
  await loadActive();
  log.info("session manager loaded", {
    activeSessions: Object.keys(active).length,
  });
}

// Look up the active session for a chat, rotating if it's stale. The runtime
// calls this at the start of each handleMessage.
export async function resolveSession(chatId: number): Promise<ResolvedSession> {
  const key = String(chatId);
  const now = Date.now();
  const current = active[key];

  if (current && !isStale(current, now)) {
    return { sessionId: current.sessionId, isNew: false };
  }

  // Either no active session or it aged out — rotate.
  const rotatedFrom = current?.sessionId;
  if (rotatedFrom) {
    log.info("rotating session (auto)", { chatId: key, sessionId: rotatedFrom });
    await archive(rotatedFrom);
  }

  const sessionId = newSessionId(new Date(now));
  active[key] = { sessionId, startedAt: now, lastMessageAt: now };
  await persistActive();
  log.info("created session", { chatId: key, sessionId });
  return { sessionId, isNew: true, rotatedFrom };
}

// `/new` command path — force-rotate regardless of staleness. Returns the
// fresh session along with the id of whatever it replaced (Phase 5's
// summarizer will use `rotatedFrom` to append a `recent.md` entry).
export async function forceRotate(chatId: number): Promise<ResolvedSession> {
  const key = String(chatId);
  const previous = active[key]?.sessionId;
  if (previous) {
    log.info("rotating session (manual)", { chatId: key, sessionId: previous });
    await archive(previous);
    delete active[key];
  }
  const fresh = await resolveSession(chatId);
  return { ...fresh, rotatedFrom: previous ?? fresh.rotatedFrom };
}

// Compaction entry stored inline in the session JSONL — DESIGN.md §10.
// "Everything before me is now this summary." Subsequent loads collapse the
// pre-compaction messages and surface the summary as `previousSummary`.
export interface CompactionEntry {
  type: "compaction";
  timestamp: number;
  summary: string;
  tokensBefore: number;
}

// What `load` returns. The runtime composes `effective = [synthetic-summary
// message wrapping previousSummary] + tail` to feed the agent.
export interface LoadedSession {
  /** Most recent compaction's summary text, if any compactions exist. */
  previousSummary?: string;
  /** Messages appended AFTER the most recent compaction entry. */
  tail: AgentMessage[];
}

function isCompactionEntry(parsed: unknown): parsed is CompactionEntry {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: string }).type === "compaction"
  );
}

// Read the active session's JSONL, applying any compaction entries. Walk
// forward: each compaction entry replaces the running tail with itself
// (i.e., it represents "everything before me is now this summary"). The
// final state is whatever messages came after the most recent compaction
// plus the most recent summary (if any).
//
// Trailing assistant messages with unanswered tool calls are dropped (open
// question #7) — they happen when the process crashed mid-tool. A re-prompt
// from the user starts a clean turn.
export async function load(sessionId: string): Promise<LoadedSession> {
  return loadFile(sessionFile(sessionId));
}

// Same forward-walk semantics, but reads from the archive directory. Used
// by the session-end summarizer (Phase 5) to compress a rotated session
// down to a one-line `recent.md` entry without ever touching the raw,
// pre-compaction history.
export async function loadArchived(sessionId: string): Promise<LoadedSession> {
  return loadFile(archivedSessionFile(sessionId));
}

// Walk the tail and remove assistant messages with toolCall content blocks
// that don't have all their tool results. In the simple end-of-transcript
// case (which is what we care about), any trailing assistant-with-toolCall
// is dangling because nothing follows it.
function dropDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
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

// Append a batch of new messages to the session's JSONL. Single fs call
// to keep the write atomic at typical sizes (well under PIPE_BUF).
export async function appendMessages(
  sessionId: string,
  messages: AgentMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await appendFile(sessionFile(sessionId), lines, "utf-8");
}

// Append a compaction entry to the session's JSONL. Once written, the next
// `load` will surface the summary as `previousSummary` and treat any
// subsequent messages as the new tail.
export async function appendCompactionEntry(
  sessionId: string,
  entry: { summary: string; tokensBefore: number },
): Promise<void> {
  const line: CompactionEntry = {
    type: "compaction",
    timestamp: Date.now(),
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
  };
  await appendFile(sessionFile(sessionId), JSON.stringify(line) + "\n", "utf-8");
}

// Stamp lastMessageAt after a successful turn so the inactivity rotation
// timer resets. Called by the runtime after appendMessages.
export async function markActivity(chatId: number): Promise<void> {
  const key = String(chatId);
  const entry = active[key];
  if (!entry) return;
  entry.lastMessageAt = Date.now();
  await persistActive();
}
