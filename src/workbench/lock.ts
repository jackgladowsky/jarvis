import { join } from "node:path";
import { withFileLock } from "../lib/durable-file.js";
import { paths } from "../paths.js";

const WORKBENCH_LOCK_TARGET = join(paths.workbench, "browser-run");
const WORKBENCH_LOCK_TIMEOUT_MS = 15 * 60_000;
const WORKBENCH_LOCK_POLL_MS = 250;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function lockTimedOut(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("timed out waiting for state lock:");
}

/**
 * Serialize use of Playwright's single persistent profile across chats and
 * JARVIS processes. Short lock attempts let cancellation interrupt a waiter
 * without ever entering the protected browser operation.
 */
export async function withWorkbenchLock<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WORKBENCH_LOCK_TIMEOUT_MS;
  while (true) {
    throwIfAborted(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("timed out waiting for the browser workbench lock");
    try {
      return await withFileLock(WORKBENCH_LOCK_TARGET, fn, {
        timeoutMs: Math.min(WORKBENCH_LOCK_POLL_MS, remaining),
        // A live owner is never reclaimed. This only delays reclaiming a dead
        // owner long enough to avoid racing an initializing lock directory.
        staleMs: 120_000,
      });
    } catch (err) {
      if (!lockTimedOut(err)) throw err;
    }
  }
}
