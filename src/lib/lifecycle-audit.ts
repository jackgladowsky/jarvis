import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";
import { paths } from "../paths.js";
import { appendFileDurable } from "./durable-file.js";
import { log, sanitize } from "./logger.js";

export interface LifecycleContext {
  run_id: string;
  run_kind: "chat" | "scheduled" | "background" | "notification";
  session_id?: string;
  turn_id?: string;
  chat_id?: number;
  task_id?: string;
  attempt_id?: string;
}

export interface LifecycleEvent extends Partial<LifecycleContext> {
  schema_version: 1;
  event_id: string;
  ts: string;
  type: string;
  outcome?: "start" | "ok" | "error" | "cancelled" | "retry" | "degraded";
  tool_call_id?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  data?: unknown;
  audit_degraded?: boolean;
}

const storage = new AsyncLocalStorage<LifecycleContext>();
let writeTail: Promise<void> = Promise.resolve();
let failures = 0;
const MAX_EVENT_BYTES = 16 * 1024;
const MAX_DEPTH = 8;
const MAX_ITEMS = 64;
const MAX_STRING_BYTES = 2 * 1024;
const MAX_DESCRIPTOR_NODES = 2_048;

export function currentLifecycleContext(): LifecycleContext | undefined {
  return storage.getStore();
}

export function withLifecycleContext<T>(context: LifecycleContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function childLifecycleContext(extra: Partial<LifecycleContext>): LifecycleContext | undefined {
  const current = storage.getStore();
  return current ? { ...current, ...extra } : undefined;
}

function boundedString(value: string): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= MAX_STRING_BYTES) return value;
  return `${Buffer.from(value).subarray(0, MAX_STRING_BYTES).toString("utf-8")}[truncated ${bytes - MAX_STRING_BYTES} bytes]`;
}

/** Bound depth/items/strings and cycles before generic redaction or JSON serialization. */
function boundedValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return boundedString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return "[max-depth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) {
    return { name: value.name, message: boundedString(value.message), stack: boundedString(value.stack ?? "") };
  }
  if (Array.isArray(value)) {
    return [
      ...value.slice(0, MAX_ITEMS).map((item) => boundedValue(item, depth + 1, seen)),
      ...(value.length > MAX_ITEMS ? [`[${value.length - MAX_ITEMS} items omitted]`] : []),
    ];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, MAX_ITEMS)) out[boundedString(key)] = boundedValue(item, depth + 1, seen);
  if (entries.length > MAX_ITEMS) out.__omitted_keys = entries.length - MAX_ITEMS;
  return out;
}

/**
 * Produce a bounded structural digest without first materializing/stringifying
 * the whole input. Giant strings are fed directly to the hash; object walks
 * stop after a fixed node count and safely detect cycles.
 */
export function payloadDescriptor(value: unknown): {
  bytes: number;
  sha256: string;
  keys?: string[];
  items?: number;
  bounded?: boolean;
} {
  const hash = createHash("sha256");
  let bytes = 0;
  let nodes = 0;
  let bounded = false;
  const seen = new WeakSet<object>();
  const feed = (text: string) => {
    bytes += Buffer.byteLength(text);
    hash.update(text);
  };
  const walk = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_DESCRIPTOR_NODES || depth > MAX_DEPTH) {
      bounded = true;
      feed("[bounded]");
      return;
    }
    if (typeof item === "string") return feed(item);
    if (item === null || typeof item !== "object") return feed(String(item));
    if (seen.has(item)) return feed("[circular]");
    seen.add(item);
    if (Array.isArray(item)) {
      feed("[");
      for (const child of item.slice(0, MAX_ITEMS)) walk(child, depth + 1);
      if (item.length > MAX_ITEMS) {
        bounded = true;
        feed(`[+${item.length - MAX_ITEMS}]`);
      }
      return feed("]");
    }
    feed("{");
    const entries = Object.entries(item as Record<string, unknown>);
    for (const [key, child] of entries.slice(0, MAX_ITEMS)) {
      feed(key);
      walk(child, depth + 1);
    }
    if (entries.length > MAX_ITEMS) {
      bounded = true;
      feed(`{+${entries.length - MAX_ITEMS}}`);
    }
    feed("}");
  };
  walk(value, 0);
  return {
    bytes,
    sha256: hash.digest("hex"),
    ...(Array.isArray(value) ? { items: value.length } : {}),
    ...(value && typeof value === "object" && !Array.isArray(value)
      ? {
          keys: Object.keys(value as Record<string, unknown>)
            .slice(0, MAX_ITEMS)
            .sort(),
        }
      : {}),
    ...(bounded ? { bounded: true } : {}),
  };
}

function boundEvent(event: LifecycleEvent): LifecycleEvent {
  const safe = sanitize(boundedValue(event)) as LifecycleEvent;
  const encoded = JSON.stringify(safe);
  if (Buffer.byteLength(encoded) <= MAX_EVENT_BYTES) return safe;
  return {
    ...safe,
    data: { omitted: true, descriptor: payloadDescriptor(safe.data) },
  };
}

/** Best-effort durable lifecycle event. Failure is loud but never makes a completed side effect retryable. */
export async function auditLifecycle(
  type: string,
  fields: Omit<Partial<LifecycleEvent>, "schema_version" | "event_id" | "ts" | "type"> = {},
  options: { append?: (path: string, data: string) => Promise<void> } = {},
): Promise<boolean> {
  if (!config.logging.audit_log_enabled) return true;
  let event: LifecycleEvent;
  try {
    event = boundEvent({
      schema_version: 1,
      event_id: randomUUID(),
      ts: new Date().toISOString(),
      ...storage.getStore(),
      ...fields,
      type,
      ...(failures > 0 ? { audit_degraded: true } : {}),
    });
  } catch (err) {
    failures += 1;
    log.error("failed to sanitize lifecycle audit event", {
      type,
      auditFailures: failures,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const append = options.append ?? appendFileDurable;
  const write = writeTail.then(() => append(paths.lifecycleAudit, `${JSON.stringify(event)}\n`));
  writeTail = write.catch(() => undefined);
  try {
    await write;
    return true;
  } catch (err) {
    failures += 1;
    log.error("failed to append lifecycle audit event", {
      type,
      auditFailures: failures,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function lifecycleAuditFailureCount(): number {
  return failures;
}
