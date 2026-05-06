// Two distinct logging concerns live here:
//
//   1. `log` — level-gated console logging for app diagnostics. Stderr for
//      warn/error, stdout for the rest. systemd captures both via journald.
//
//   2. `auditToolCall` — append-only structured JSONL audit of every tool
//      call. With confirmation flows gone (DESIGN.md §5), this log is the
//      actual safeguard: "what did JARVIS do" is answered by `cat audit.log`.
//
// Both are configured via `config.logging` in config.yaml.

import { appendFile } from "node:fs/promises";
import { config } from "../config.js";
import { paths } from "../paths.js";

// ─── App log ────────────────────────────────────────────────────────────────

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

// ─── Audit log ──────────────────────────────────────────────────────────────

// Patterns that look like secrets. The list is intentionally short and
// conservative — false positives ("[REDACTED]" appearing where a normal value
// belongs) are cheaper than false negatives (real secret leaking into the log).
//
//   - sk-...        : OpenAI / Anthropic style API keys
//   - ghp_...       : GitHub personal access tokens
//   - eyJ... . ... .: anything JWT-shaped (Codex OAuth creds, etc.)
//   - SHOUTY=longstr: shell-style env assignments with long values
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
    // For the SHOUTY=value pattern, keep the prefix (so logs stay grep-able)
    // and redact only the value. For everything else, replace the whole match.
    out = out.replace(p, (match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

// Truncate huge values to keep the audit log readable. Keeps both head and
// tail so that things like exit-status lines at the end of a long bash output
// are still visible.
function truncate(value: string): string {
  const max = config.logging.audit_log_max_value_bytes;
  const buf = Buffer.from(value, "utf-8");
  if (buf.length <= max) return value;
  const half = Math.floor(max / 2);
  const head = buf.subarray(0, half).toString("utf-8");
  const tail = buf.subarray(buf.length - half).toString("utf-8");
  return `${head}...[truncated ${buf.length - max} bytes]...${tail}`;
}

// Recursively sanitize a value before it lands on disk. Strings get redacted
// and truncated; arrays and plain objects are walked; everything else passes
// through unchanged.
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
  ts: string;          // ISO timestamp
  tool: string;        // tool name (read / write / edit / bash)
  args: unknown;       // args after sanitize() — safe to log
  outcome: "ok" | "error";
  duration_ms: number;
  exit?: number;       // bash only
  bytes?: number;      // read / write / edit
  error?: string;      // populated on outcome="error"
}

// One JSONL line per call. `appendFile` is atomic up to PIPE_BUF on POSIX
// (~4KB) — at our typical entry sizes that's more than enough for concurrent
// tool calls not to interleave mid-line.
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
