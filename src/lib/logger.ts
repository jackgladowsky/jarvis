import { appendFile } from "node:fs/promises";
import { config } from "../config.js";
import { paths } from "../paths.js";

type Level = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVEL_ORDER[config.logging.level];

function emit(level: Level, args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const ts = new Date().toISOString();
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(`[${ts}] [${level}]`, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /([A-Z_]+=)([A-Za-z0-9+/=]{20,})/g,
];

function redact(value: string): string {
  if (!config.logging.audit_log_redact_patterns) return value;
  let out = value;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

function truncate(value: string): string {
  const max = config.logging.audit_log_max_value_bytes;
  const buf = Buffer.from(value, "utf-8");
  if (buf.length <= max) return value;
  const half = Math.floor(max / 2);
  const head = buf.subarray(0, half).toString("utf-8");
  const tail = buf.subarray(buf.length - half).toString("utf-8");
  return `${head}...[truncated ${buf.length - max} bytes]...${tail}`;
}

export function sanitize(value: unknown): unknown {
  if (typeof value === "string") return truncate(redact(value));
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  ts: string;
  tool: string;
  args: unknown;
  outcome: "ok" | "error";
  duration_ms: number;
  exit?: number;
  bytes?: number;
  error?: string;
}

export async function auditToolCall(
  partial: Omit<AuditEntry, "ts" | "args"> & { args: unknown },
): Promise<void> {
  if (!config.logging.audit_log_enabled) return;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    ...partial,
    args: sanitize(partial.args),
  };
  await appendFile(paths.audit, JSON.stringify(entry) + "\n", "utf-8");
}
