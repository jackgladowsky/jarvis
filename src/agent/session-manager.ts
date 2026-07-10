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

import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { atomicWriteFile, atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { appendJsonLinesDurable, readJsonLinesRecovering } from "../lib/json-lines.js";
import { paths } from "../paths.js";

// Per-chat metadata stored in active.json. Keyed by chat id (stringified, since
// JSON object keys are always strings).
export interface ActiveSessionEntry {
  sessionId: string;
  startedAt: number; // ms epoch
  lastMessageAt: number; // ms epoch
}

type ActiveSessions = Record<string, ActiveSessionEntry>;

// In-memory mirror of active.json. Loaded once at startup, written through
// on every change.
let active: ActiveSessions = {};

// Format: YYYY-MM-DD_HHMM_<UUID> — date-prefixed for grep-friendliness with
// 122 random UUIDv4 bits and an exclusive file reservation for collision safety.
function newSessionId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${date}_${time}_${randomUUID()}`;
}

function sessionFile(id: string): string {
  assertSessionId(id);
  return join(paths.sessions, `${id}.jsonl`);
}

function archivedSessionFile(id: string): string {
  assertSessionId(id);
  return join(paths.sessionsArchive, `${id}.jsonl`);
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
}

// Shared parser used by both `load` (active session) and `loadArchived`
// (already-rotated session). Walks forward applying compaction entries.
async function loadFile(filePath: string): Promise<LoadedSession> {
  const records = await readJsonLinesRecovering<unknown>(filePath);
  let previousSummary: string | undefined;
  let tail: AgentMessage[] = [];
  for (const [index, parsed] of records.entries()) {
    if (isCompactionEntry(parsed)) {
      previousSummary = parsed.summary;
      tail = []; // everything before this is now folded into the summary
    } else if (isAgentMessage(parsed)) {
      tail.push(parsed as AgentMessage);
    } else {
      throw new SyntaxError(`invalid session JSONL record at line ${index + 1}`);
    }
  }

  return { previousSummary, tail: dropDanglingToolCalls(tail) };
}

async function readActive(): Promise<ActiveSessions> {
  try {
    const raw = await readFile(paths.activeSessions, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError(`malformed active sessions at ${paths.activeSessions}`);
    }
    const validated: ActiveSessions = {};
    for (const [chatId, value] of Object.entries(parsed)) {
      const candidate = value as Partial<ActiveSessionEntry> | null;
      if (
        !/^-?\d+$/.test(chatId) ||
        typeof candidate !== "object" ||
        candidate === null ||
        typeof candidate.sessionId !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(candidate.sessionId) ||
        typeof candidate.startedAt !== "number" ||
        !Number.isFinite(candidate.startedAt) ||
        typeof candidate.lastMessageAt !== "number" ||
        !Number.isFinite(candidate.lastMessageAt)
      ) {
        throw new SyntaxError(`malformed active session entry for chat ${chatId}`);
      }
      validated[chatId] = {
        sessionId: candidate.sessionId,
        startedAt: candidate.startedAt,
        lastMessageAt: candidate.lastMessageAt,
      };
    }
    return validated;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function persistActive(next: ActiveSessions): Promise<void> {
  await atomicWriteJson(paths.activeSessions, next);
  active = next;
}

async function reserveSession(now: Date): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sessionId = newSessionId(now);
    let handle;
    try {
      handle = await open(sessionFile(sessionId), "wx", 0o600);
      await handle.sync();
      await handle.close();
      return sessionId;
    } catch (err) {
      await handle?.close().catch(() => undefined);
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("unable to reserve a unique session id after 10 attempts");
}

async function sessionExists(sessionId: string): Promise<boolean> {
  try {
    await access(sessionFile(sessionId), constants.F_OK);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function archiveUnreferencedSessions(next: ActiveSessions): Promise<void> {
  const referenced = new Set(Object.values(next).map((entry) => entry.sessionId));
  const entries = await readdir(paths.sessions, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.slice(0, -".jsonl".length);
    if (referenced.has(sessionId)) continue;
    try {
      await access(archivedSessionFile(sessionId), constants.F_OK);
      const conflict = join(paths.sessionsArchive, `${sessionId}.conflict-${Date.now()}-${randomUUID()}.jsonl`);
      await rename(sessionFile(sessionId), conflict);
      log.warn("preserved conflicting unreferenced session under a unique archive name", {
        sessionId,
        conflict,
      });
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await archive(sessionId).catch((err) =>
      log.warn("failed to reconcile unreferenced live session", {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
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
  await withFileLock(paths.activeSessions, async () => {
    const next = await readActive();
    let repaired = false;
    for (const [chatId, entry] of Object.entries(next)) {
      if (await sessionExists(entry.sessionId)) continue;
      const timestamp = Date.now();
      const sessionId = await reserveSession(new Date(timestamp));
      next[chatId] = { sessionId, startedAt: timestamp, lastMessageAt: timestamp };
      repaired = true;
      log.warn("repaired active session with missing live transcript", {
        chatId,
        missingSessionId: entry.sessionId,
        sessionId,
      });
    }
    if (repaired) await persistActive(next);
    else active = next;
    await archiveUnreferencedSessions(next);
  });
  log.info("session manager loaded", {
    activeSessions: Object.keys(active).length,
  });
}

// Look up the active session for a chat, rotating if it's stale. The runtime
// calls this at the start of each handleMessage.
export function getActiveSession(chatId: number): ActiveSessionEntry | undefined {
  const entry = active[String(chatId)];
  return entry ? { ...entry } : undefined;
}

export async function resolveSession(chatId: number): Promise<ResolvedSession> {
  return withFileLock(paths.activeSessions, async () => {
    const key = String(chatId);
    const timestamp = Date.now();
    const next = await readActive();
    active = next;
    const current = next[key];

    if (current && !isStale(current, timestamp) && (await sessionExists(current.sessionId))) {
      return { sessionId: current.sessionId, isNew: false };
    }

    const rotatedFrom = current?.sessionId;
    const sessionId = await reserveSession(new Date(timestamp));
    next[key] = { sessionId, startedAt: timestamp, lastMessageAt: timestamp };
    await persistActive(next);
    if (rotatedFrom) {
      log.info("rotating session (auto)", { chatId: key, sessionId: rotatedFrom });
      await archive(rotatedFrom).catch((err) =>
        log.warn("session archive deferred after active-session rotation", {
          chatId: key,
          sessionId: rotatedFrom,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    log.info("created session", { chatId: key, sessionId });
    return { sessionId, isNew: true, rotatedFrom };
  });
}

// `/new` command path — force-rotate regardless of staleness. Returns the
// fresh session along with the id of whatever it replaced (Phase 5's
// summarizer will use `rotatedFrom` to append a `recent.md` entry).
export async function forceRotate(chatId: number): Promise<ResolvedSession> {
  return withFileLock(paths.activeSessions, async () => {
    const key = String(chatId);
    const next = await readActive();
    active = next;
    const previous = next[key]?.sessionId;
    const timestamp = Date.now();
    const sessionId = await reserveSession(new Date(timestamp));
    next[key] = { sessionId, startedAt: timestamp, lastMessageAt: timestamp };
    await persistActive(next);
    if (previous) {
      log.info("rotating session (manual)", { chatId: key, sessionId: previous });
      await archive(previous).catch((err) =>
        log.warn("session archive deferred after active-session rotation", {
          chatId: key,
          sessionId: previous,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    log.info("created session", { chatId: key, sessionId });
    return { sessionId, isNew: true, rotatedFrom: previous };
  });
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
    (parsed as { type?: string }).type === "compaction" &&
    typeof (parsed as { summary?: unknown }).summary === "string" &&
    typeof (parsed as { tokensBefore?: unknown }).tokensBefore === "number"
  );
}

function isAgentMessage(parsed: unknown): parsed is AgentMessage {
  if (typeof parsed !== "object" || parsed === null) return false;
  const role = (parsed as { role?: unknown }).role;
  return ["user", "assistant", "toolResult"].includes(String(role));
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

// Append a batch of new messages to the session's JSONL. Single fs call
// to keep the write atomic at typical sizes (well under PIPE_BUF).
export async function appendMessages(sessionId: string, messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await appendJsonLinesDurable(sessionFile(sessionId), lines);
}

// Atomically replace a chat transcript with its newest compaction checkpoint
// followed by the recent messages that were deliberately kept. Appending the
// checkpoint at EOF would make the forward loader reset `tail` after those
// messages and silently discard them on the next load.
export async function rewriteSessionWithCompaction(
  sessionId: string,
  entry: { summary: string; tokensBefore: number },
  keptTail: AgentMessage[],
): Promise<void> {
  const file = sessionFile(sessionId);
  const compaction: CompactionEntry = {
    type: "compaction",
    timestamp: Date.now(),
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
  };
  const lines = [JSON.stringify(compaction), ...keptTail.map((message) => JSON.stringify(message))];
  await withFileLock(file, () => atomicWriteFile(file, `${lines.join("\n")}\n`));
}

// Stamp lastMessageAt after a successful turn so the inactivity rotation
// timer resets. Called by the runtime after appendMessages.
export async function markActivity(chatId: number): Promise<void> {
  await withFileLock(paths.activeSessions, async () => {
    const key = String(chatId);
    const next = await readActive();
    const entry = next[key];
    if (!entry) {
      active = next;
      return;
    }
    entry.lastMessageAt = Date.now();
    await persistActive(next);
  });
}
