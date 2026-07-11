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

import { config } from "../config.js";
import { paths } from "../paths.js";
import { appendFileDurable } from "./durable-file.js";

// ─── App log ────────────────────────────────────────────────────────────────
//
// Single-line `<ts?> <level> <message> key=val key=val` output. systemd's
// journald already prefixes wall-clock + unit/pid; when we detect we're
// running under it (JOURNAL_STREAM is set on stdout/stderr by systemd) we
// drop our own ISO timestamp to avoid duplication. Outside journald (bare
// `node dist/index.js`, dev runs) we keep it so logs stay self-describing.

type Level = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVEL_ORDER[config.logging.level];
const inJournald = !!process.env.JOURNAL_STREAM;

function fmtField(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === "string") return /[\s"=]/.test(v) || v === "" ? JSON.stringify(v) : v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fmtMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k}=${fmtField(v)}`)
    .join(" ");
}

function emit(level: Level, args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel) return;
  const stream = level === "error" || level === "warn" ? console.error : console.log;

  const last = args.at(-1);
  const isMeta =
    args.length >= 2 && last !== null && typeof last === "object" && !Array.isArray(last) && !(last instanceof Error);

  let body: string;
  if (isMeta) {
    const head = args
      .slice(0, -1)
      .map((a) => (typeof a === "string" ? a : fmtField(a)))
      .join(" ");
    const meta = fmtMeta(last as Record<string, unknown>);
    body = meta ? `${head} ${meta}` : head;
  } else {
    body = args.map((a) => (typeof a === "string" ? a : fmtField(a))).join(" ");
  }

  const prefix = inJournald ? level.padEnd(5) : `${new Date().toISOString()} ${level.padEnd(5)}`;
  stream(`${prefix} ${body}`);
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
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*=)(?:'[^']*'|"[^"]*"|[^\s;&|]+)/g,
];

const SENSITIVE_KEY = /(?:^|[_-])(token|secret|password|passwd|authorization|api[_-]?key|credential|cookie)(?:$|[_-])/i;
const SENSITIVE_QUERY_KEY = /token|secret|password|passwd|authorization|api[_-]?key|credential|signature|sig/i;

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username) url.username = "[REDACTED]";
    if (url.password) url.password = "[REDACTED]";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function redact(value: string): string {
  if (!config.logging.audit_log_redact_patterns) return value;
  let out = value.replace(/https?:\/\/[^\s"'<>]+/g, redactUrl);
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (_match, prefix?: string | number) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
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
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitize(v);
    }
    return out;
  }
  return value;
}

export interface AuditEntry {
  ts: string; // ISO timestamp
  tool: string; // tool name (read / write / edit / bash)
  args: unknown; // args after sanitize() — safe to log
  outcome: "ok" | "error";
  duration_ms: number;
  exit?: number; // bash only
  bytes?: number; // read / write / edit
  error?: string; // populated on outcome="error"
}

// Serialize audit writes. Besides keeping oversized JSONL records from
// interleaving, using a recovery tail means one disk error cannot poison all
// later writes.
let auditWriteTail: Promise<void> = Promise.resolve();

// One JSONL line per call. Writes flow through the serialized tail above so
// concurrent tool completions cannot interleave records.
export async function auditToolCall(partial: Omit<AuditEntry, "ts" | "args"> & { args: unknown }): Promise<void> {
  if (!config.logging.audit_log_enabled) return;
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    ...partial,
    args: sanitize(partial.args),
  };
  const write = auditWriteTail.then(async () => {
    await appendFileDurable(paths.audit, JSON.stringify(entry) + "\n");
  });
  auditWriteTail = write.catch(() => undefined);

  try {
    await write;
  } catch (err) {
    // Auditing happens after a tool operation. A full/read-only disk must not
    // turn a successful side effect into an apparent tool failure, because
    // the model could then repeat it. Keep the operational result intact and
    // make the loss of audit durability loud in the application log.
    log.error("failed to append tool audit entry", {
      tool: partial.tool,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
