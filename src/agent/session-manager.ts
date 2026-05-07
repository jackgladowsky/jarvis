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

// Read the JSONL transcript for a session. Returns an empty array if the
// file doesn't exist (fresh session).
//
// Trailing assistant messages with unanswered tool calls are dropped (open
// question #7) — they happen when the process crashed mid-tool. A re-prompt
// from the user starts a clean turn.
export async function loadMessages(sessionId: string): Promise<AgentMessage[]> {
  let raw: string;
  try {
    raw = await readFile(sessionFile(sessionId), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const messages = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AgentMessage);
  return dropDanglingToolCalls(messages);
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

// Stamp lastMessageAt after a successful turn so the inactivity rotation
// timer resets. Called by the runtime after appendMessages.
export async function markActivity(chatId: number): Promise<void> {
  const key = String(chatId);
  const entry = active[key];
  if (!entry) return;
  entry.lastMessageAt = Date.now();
  await persistActive();
}
