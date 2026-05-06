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

const tails = new Map<string | number, Promise<unknown>>();

export function withLock<T>(key: string | number, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Use the same handler for both fulfilled and rejected `prev` so a thrown
  // earlier task doesn't break the chain — every queued call gets its turn.
  const next = prev.then(fn, fn);
  tails.set(key, next);
  // Best-effort cleanup: if we're still the tail when this settles, drop the
  // entry. If a newer call arrived in the meantime, it owns the slot now.
  next.finally(() => {
    if (tails.get(key) === next) tails.delete(key);
  });
  return next;
}
