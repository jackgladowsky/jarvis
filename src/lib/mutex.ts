// Per-key serialized execution.
//
// Telegram's grammy library invokes message handlers concurrently — if two
// messages from the same chat arrive close together, both handlers start
// running in parallel. That would corrupt session state and let the agent
// loop interleave tool calls. DESIGN.md §10 specifies a per-`chat_id` mutex
// to prevent this; subsequent messages from the same chat queue behind the
// in-flight one.
//
// Implementation: keep a `tail` promise per key. Each new call chains its work
// onto that tail and becomes the new tail. When the tail settles and no new
// work has arrived, the entry is removed so the map doesn't grow unbounded.
//
// v1 has no `/cancel` (DESIGN.md open question #10) — a long-running tool call
// will block the next message from that chat until it finishes.

import { join } from "node:path";
import { paths } from "../paths.js";
import { withFileLock } from "./durable-file.js";

const tails = new Map<string | number, Promise<unknown>>();
const CHAT_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

function runLocked<T>(key: string | number, fn: () => Promise<T>): Promise<T> {
  // Numeric keys are Telegram chat IDs. The in-memory tail prevents local
  // overlap; this durable lock also protects sessions when an accidental
  // second service/foreground process is polling the same bot.
  if (typeof key !== "number") return fn();
  if (!Number.isSafeInteger(key)) return Promise.reject(new Error(`invalid chat lock key: ${key}`));
  return withFileLock(join(paths.chatLocks, `${key}.turn`), fn, {
    timeoutMs: CHAT_LOCK_TIMEOUT_MS,
  });
}

export function withLock<T>(key: string | number, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Use the same handler for both fulfilled and rejected `prev` so a thrown
  // earlier task doesn't break the chain — every queued call gets its turn.
  const run = () => runLocked(key, fn);
  const next = prev.then(run, run);
  tails.set(key, next);
  // Best-effort cleanup: if we're still the tail when this settles, drop the
  // entry. If a newer call arrived in the meantime, it owns the slot now.
  // Do not use an ignored `next.finally(...)` here. `finally` creates a new
  // promise that mirrors `next`; when `fn` rejects that otherwise-unobserved
  // promise becomes an unhandled rejection even if the caller handles
  // `next`. A two-branch `then` runs cleanup without creating a rejected
  // cleanup promise.
  const cleanup = (): void => {
    if (tails.get(key) === next) tails.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}
