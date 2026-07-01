import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderResponse,
  type SimpleStreamOptions,
  type Usage,
} from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { config, env } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

export type LlmTelemetryScopeKind = "chat" | "scheduled" | "background" | "compaction" | "summarizer" | "classifier" | "other";
export type LlmTelemetryEventType = "llm.call.started" | "llm.call.first_token" | "llm.call.finished" | "llm.call.failed";
export type LlmTelemetryContentMode = "metadata" | "preview" | "full";

export interface LlmTelemetryScope {
  kind: LlmTelemetryScopeKind;
  session_id?: string;
  chat_id_hash?: string;
  task_id?: string;
  task_name?: string;
  source_path?: string;
  attempt_label?: string;
  message_ts?: string;
}

export interface LlmTelemetryEvent {
  schema_version: 1;
  event_id: string;
  call_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  event_type: LlmTelemetryEventType;
  ts: string;
  host: string;
  pid: number;
  service: { name: "jarvis"; version?: string };
  scope: LlmTelemetryScope;
  otel: Record<string, string | number | boolean | string[]>;
  privacy: { content_mode: LlmTelemetryContentMode; redaction_applied: boolean; truncated: boolean };
  provider?: string;
  api?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  timing?: { duration_ms?: number; time_to_first_token_ms?: number };
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number };
  cost?: { usd_estimate?: number; raw?: unknown };
  status?: "ok" | "error" | "aborted";
  error?: { type: string; message: string };
}

type StreamDelegate = <TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const HOST = hostname();
const SERVICE_VERSION = process.env.npm_package_version;
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /([A-Z][A-Z0-9_]{2,}=)([A-Za-z0-9+/=_-]{16,})/g,
];

let drainTimer: NodeJS.Timeout | undefined;
let drainRunning = false;
let cleanupAt = 0;
let warnedMissingHttpConfig = false;
let warnedOversize = false;
const retryAfter = new Map<string, number>();

function telemetryConfig() {
  return config.observability.llm_telemetry;
}

function eventDir(): string {
  return telemetryConfig().events_dir ?? join(paths.observability, "llm-events");
}

function queueDir(): string {
  return telemetryConfig().queue_dir ?? join(paths.observability, "llm-telemetry-queue");
}

function isEnabled(): boolean {
  const cfg = telemetryConfig();
  return cfg.enabled && cfg.sink !== "off";
}

function wantsFile(): boolean {
  const sink = telemetryConfig().sink;
  return sink === "file" || sink === "both";
}

function wantsHttp(): boolean {
  const sink = telemetryConfig().sink;
  return sink === "http" || sink === "both";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return inner;
  });
}

export function hashTelemetryIdentifier(value: string | number): string {
  return sha256(`${paths.data}:${String(value)}`);
}

export function redactTelemetryText(value: string): { text: string; redacted: boolean } {
  let out = value;
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) => {
      redacted = true;
      return prefix ? `${prefix}[REDACTED]` : "[REDACTED]";
    });
  }
  return { text: out, redacted };
}

function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, maxChars - 1))}…`, truncated: true };
}

function preview(value: unknown): { preview?: string; redacted: boolean; truncated: boolean } {
  const mode = telemetryConfig().content_mode;
  if (mode === "metadata") return { redacted: false, truncated: false };
  const raw = typeof value === "string" ? value : stableJson(value);
  const redacted = redactTelemetryText(raw.replace(/\s+/g, " ").trim());
  const cut = truncate(redacted.text, telemetryConfig().max_preview_chars);
  return { preview: cut.text, redacted: redacted.redacted, truncated: cut.truncated };
}

function contextTextChars(context: Context): number {
  return stableJson({ systemPrompt: context.systemPrompt, messages: context.messages }).length;
}

function safeHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}

function usageTelemetry(usage: Usage | undefined): LlmTelemetryEvent["usage"] {
  return {
    input_tokens: usage?.input ?? 0,
    output_tokens: usage?.output ?? 0,
    total_tokens: usage?.totalTokens ?? (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
    cache_read_tokens: usage?.cacheRead,
    cache_write_tokens: usage?.cacheWrite,
  };
}

function costTelemetry(usage: Usage | undefined): LlmTelemetryEvent["cost"] {
  return { usd_estimate: usage?.cost?.total };
}

function outputText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function otelBase(model: Model<any>, response?: AssistantMessage): Record<string, string | number | boolean | string[]> {
  const attrs: Record<string, string | number | boolean | string[]> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": model.provider,
    "gen_ai.request.model": model.id,
    "server.address": safeHost(model.baseUrl) ?? model.baseUrl,
  };
  if (response?.responseModel ?? response?.model) attrs["gen_ai.response.model"] = response.responseModel ?? response.model;
  if (response?.responseId) attrs["gen_ai.response.id"] = response.responseId;
  if (response?.stopReason) attrs["gen_ai.response.finish_reasons"] = [response.stopReason];
  if (response?.usage) {
    attrs["gen_ai.usage.input_tokens"] = response.usage.input;
    attrs["gen_ai.usage.output_tokens"] = response.usage.output;
  }
  return attrs;
}

function envelope(
  event_type: LlmTelemetryEventType,
  ids: { call_id: string; trace_id: string; span_id: string },
  scope: LlmTelemetryScope,
  model: Model<any>,
  extra: Partial<LlmTelemetryEvent> = {},
): LlmTelemetryEvent {
  return {
    schema_version: 1,
    event_id: randomUUID(),
    call_id: ids.call_id,
    trace_id: ids.trace_id,
    span_id: ids.span_id,
    event_type,
    ts: new Date().toISOString(),
    host: HOST,
    pid: process.pid,
    service: { name: "jarvis", version: SERVICE_VERSION },
    scope,
    otel: otelBase(model),
    privacy: { content_mode: telemetryConfig().content_mode, redaction_applied: false, truncated: false },
    provider: model.provider,
    api: model.api,
    ...extra,
  };
}

export function buildStartedEvent(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  scope: LlmTelemetryScope,
  ids: { call_id: string; trace_id: string; span_id: string },
  rawPayload?: unknown,
): LlmTelemetryEvent {
  const inputForHash = { systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools };
  const rawPayloadPreview = rawPayload === undefined ? { redacted: false, truncated: false } : preview(rawPayload);
  const inputPreview = preview(inputForHash);
  const request: Record<string, unknown> = {
    model: model.id,
    response_model_expected: model.name,
    base_url_host: safeHost(model.baseUrl),
    temperature: options?.temperature,
    max_tokens: options?.maxTokens,
    reasoning: options?.reasoning,
    message_count: context.messages.length,
    tool_count: context.tools?.length ?? 0,
    system_prompt_sha256: context.systemPrompt ? sha256(context.systemPrompt) : undefined,
    tools_sha256: context.tools ? sha256(stableJson(context.tools)) : undefined,
    input_sha256: sha256(stableJson(inputForHash)),
    input_chars: contextTextChars(context),
    raw_payload_sha256: rawPayload === undefined ? undefined : sha256(stableJson(rawPayload)),
  };
  if (inputPreview.preview) request.input_preview = inputPreview.preview;
  if (rawPayloadPreview.preview) request.raw_payload_preview = rawPayloadPreview.preview;
  if (telemetryConfig().content_mode === "full" && telemetryConfig().capture_raw_payload) request.raw_payload = rawPayload;
  const event = envelope("llm.call.started", ids, scope, model, { request });
  event.privacy.redaction_applied = inputPreview.redacted || rawPayloadPreview.redacted;
  event.privacy.truncated = inputPreview.truncated || rawPayloadPreview.truncated;
  return event;
}

function finishedEvent(
  model: Model<any>,
  message: AssistantMessage,
  scope: LlmTelemetryScope,
  ids: { call_id: string; trace_id: string; span_id: string },
  startedAt: number,
  firstTokenAt: number | undefined,
  responseHeaders: ProviderResponse | undefined,
): LlmTelemetryEvent {
  const text = outputText(message);
  const outPreview = preview(text);
  const response: Record<string, unknown> = {
    id: message.responseId,
    generation_id: responseHeaders?.headers["x-generation-id"] ?? responseHeaders?.headers["X-Generation-Id"],
    model_requested: model.id,
    model_returned: message.responseModel ?? message.model,
    finish_reason: message.stopReason,
    output_sha256: sha256(text),
    output_chars: text.length,
  };
  if (outPreview.preview) response.output_preview = outPreview.preview;
  const event = envelope("llm.call.finished", ids, scope, model, {
    otel: otelBase(model, message),
    response,
    timing: { duration_ms: Date.now() - startedAt, time_to_first_token_ms: firstTokenAt ? firstTokenAt - startedAt : undefined },
    usage: usageTelemetry(message.usage),
    cost: costTelemetry(message.usage),
    status: "ok",
  });
  event.privacy.redaction_applied = outPreview.redacted;
  event.privacy.truncated = outPreview.truncated;
  return event;
}

function failedEvent(
  model: Model<any>,
  message: AssistantMessage | undefined,
  scope: LlmTelemetryScope,
  ids: { call_id: string; trace_id: string; span_id: string },
  startedAt: number,
  firstTokenAt: number | undefined,
  err?: unknown,
): LlmTelemetryEvent {
  const errorMessage = message?.errorMessage ?? (err instanceof Error ? err.message : String(err ?? "unknown error"));
  const status = message?.stopReason === "aborted" ? "aborted" : "error";
  return envelope("llm.call.failed", ids, scope, model, {
    otel: { ...otelBase(model, message), "error.type": status },
    response: message
      ? {
          id: message.responseId,
          model_requested: model.id,
          model_returned: message.responseModel ?? message.model,
          finish_reason: message.stopReason,
        }
      : { model_requested: model.id },
    timing: { duration_ms: Date.now() - startedAt, time_to_first_token_ms: firstTokenAt ? firstTokenAt - startedAt : undefined },
    usage: usageTelemetry(message?.usage),
    cost: costTelemetry(message?.usage),
    status,
    error: { type: status, message: truncate(errorMessage, 1000).text },
  });
}

function firstTokenEvent(
  model: Model<any>,
  scope: LlmTelemetryScope,
  ids: { call_id: string; trace_id: string; span_id: string },
  startedAt: number,
): LlmTelemetryEvent {
  return envelope("llm.call.first_token", ids, scope, model, {
    timing: { time_to_first_token_ms: Date.now() - startedAt },
  });
}

function isFirstTokenCandidate(event: AssistantMessageEvent): boolean {
  return event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta" || event.type === "toolcall_end";
}

function makeErrorMessage(model: Model<any>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

async function writeEventLog(event: LlmTelemetryEvent, json: string): Promise<void> {
  await mkdir(eventDir(), { recursive: true, mode: 0o700 });
  const day = event.ts.slice(0, 10);
  await appendFile(join(eventDir(), `${day}.jsonl`), `${json}\n`, { encoding: "utf-8", mode: 0o600 });
}

async function listQueueFiles(): Promise<string[]> {
  try {
    const entries = await readdir(queueDir(), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(queueDir(), entry.name))
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function cleanupQueue(): Promise<void> {
  const cfg = telemetryConfig();
  const now = Date.now();
  const maxAgeMs = cfg.max_event_age_days * 24 * 60 * 60 * 1000;
  const files = await listQueueFiles();
  const stats = await Promise.all(
    files.map(async (file) => ({ file, stat: await stat(file).catch(() => undefined) })),
  );
  for (const item of stats) {
    if (!item.stat) continue;
    if (now - item.stat.mtimeMs > maxAgeMs) await rm(item.file, { force: true });
  }
  const remaining = (await listQueueFiles()).sort();
  const overflow = remaining.length - cfg.queue_max_events;
  if (overflow > 0) {
    for (const file of remaining.slice(0, overflow)) await rm(file, { force: true });
    log.warn("llm telemetry queue dropped oldest events", { dropped: overflow, max: cfg.queue_max_events });
  }
}

async function queueHttpEvent(event: LlmTelemetryEvent, json: string): Promise<void> {
  const cfg = telemetryConfig();
  if (!cfg.endpoint || !env.AI_OBSERVATORY_INGEST_TOKEN) {
    if (!warnedMissingHttpConfig) {
      warnedMissingHttpConfig = true;
      log.warn("llm telemetry http sink disabled; endpoint/token missing");
    }
    return;
  }
  await mkdir(queueDir(), { recursive: true, mode: 0o700 });
  const safeTs = event.ts.replace(/[:.]/g, "-");
  await writeFile(join(queueDir(), `${safeTs}-${event.event_id}.json`), json, { encoding: "utf-8", mode: 0o600 });
  const now = Date.now();
  if (now >= cleanupAt) {
    cleanupAt = now + 60_000;
    await cleanupQueue();
  }
  triggerTelemetryDrain();
}

async function persistEvent(event: LlmTelemetryEvent): Promise<void> {
  if (!isEnabled()) return;
  const json = JSON.stringify(event);
  const bytes = Buffer.byteLength(json, "utf-8");
  if (bytes > telemetryConfig().max_payload_bytes) {
    if (!warnedOversize) {
      warnedOversize = true;
      log.warn("llm telemetry event exceeds max payload; dropping", { bytes, max: telemetryConfig().max_payload_bytes });
    }
    return;
  }
  if (wantsFile()) await writeEventLog(event, json);
  if (wantsHttp()) await queueHttpEvent(event, json);
}

export function recordLlmTelemetryEvent(event: LlmTelemetryEvent): void {
  if (!isEnabled()) return;
  void persistEvent(event).catch((err) => {
    log.warn("llm telemetry persist failed", { err: err instanceof Error ? err.message : String(err) });
  });
}

async function postQueuedFile(file: string): Promise<boolean> {
  const cfg = telemetryConfig();
  if (!cfg.endpoint || !env.AI_OBSERVATORY_INGEST_TOKEN) return false;
  const retry = retryAfter.get(file) ?? 0;
  if (Date.now() < retry) return false;
  const raw = await readFile(file, "utf-8");
  let parsed: LlmTelemetryEvent;
  try {
    parsed = JSON.parse(raw) as LlmTelemetryEvent;
  } catch {
    await rm(file, { force: true });
    return true;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.request_timeout_ms);
  try {
    const response = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AI_OBSERVATORY_INGEST_TOKEN}`,
        "idempotency-key": parsed.event_id,
      },
      body: JSON.stringify({ events: [parsed] }),
      signal: controller.signal,
    });
    if (response.ok) {
      retryAfter.delete(file);
      await rm(file, { force: true });
      return true;
    }
    const delay = response.status === 429 || response.status >= 500 ? 30_000 : 5 * 60_000;
    retryAfter.set(file, Date.now() + delay);
    return false;
  } catch {
    const previous = retryAfter.get(file);
    const base = previous && previous > Date.now() ? Math.min(previous - Date.now(), 5 * 60_000) : 5_000;
    retryAfter.set(file, Date.now() + Math.min(base * 2, 5 * 60_000));
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function drainLlmTelemetryQueueOnce(limit = 50): Promise<{ attempted: number; sent: number; remaining: number }> {
  if (!isEnabled() || !wantsHttp() || drainRunning) return { attempted: 0, sent: 0, remaining: 0 };
  drainRunning = true;
  let attempted = 0;
  let sent = 0;
  try {
    await cleanupQueue();
    const files = (await listQueueFiles()).slice(0, limit);
    for (const file of files) {
      attempted += 1;
      if (await postQueuedFile(file)) sent += 1;
    }
    return { attempted, sent, remaining: (await listQueueFiles()).length };
  } catch (err) {
    log.warn("llm telemetry drain failed", { err: err instanceof Error ? err.message : String(err) });
    return { attempted, sent, remaining: 0 };
  } finally {
    drainRunning = false;
  }
}

function triggerTelemetryDrain(): void {
  if (!isEnabled() || !wantsHttp()) return;
  setTimeout(() => void drainLlmTelemetryQueueOnce(), 0).unref?.();
}

export function startLlmTelemetryDrain(): () => void {
  if (!isEnabled() || !wantsHttp() || drainTimer) return () => undefined;
  drainTimer = setInterval(() => void drainLlmTelemetryQueueOnce(), telemetryConfig().drain_interval_ms);
  drainTimer.unref?.();
  triggerTelemetryDrain();
  return () => {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = undefined;
  };
}

export function streamSimpleWithTelemetry<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  scope: LlmTelemetryScope,
  delegate: StreamDelegate = streamSimple,
): AssistantMessageEventStream {
  if (!isEnabled()) return delegate(model, context, options);
  const ids = { call_id: randomUUID(), trace_id: randomUUID().replace(/-/g, ""), span_id: randomUUID().replace(/-/g, "").slice(0, 16) };
  const startedAt = Date.now();
  let firstTokenAt: number | undefined;
  let responseHeaders: ProviderResponse | undefined;
  let rawPayload: unknown;
  const wrappedOptions: SimpleStreamOptions = {
    ...options,
    onPayload: async (payload, payloadModel) => {
      rawPayload = payload;
      return options?.onPayload?.(payload, payloadModel);
    },
    onResponse: async (response, responseModel) => {
      responseHeaders = response;
      await options?.onResponse?.(response, responseModel);
    },
  };

  const out = createAssistantMessageEventStream();
  let inner: AssistantMessageEventStream;
  try {
    inner = delegate(model, context, wrappedOptions);
  } catch (err) {
    const message = makeErrorMessage(model, err);
    recordLlmTelemetryEvent(buildStartedEvent(model, context, options, scope, ids, rawPayload));
    recordLlmTelemetryEvent(failedEvent(model, message, scope, ids, startedAt, firstTokenAt, err));
    out.push({ type: "error", reason: "error", error: message });
    return out;
  }

  recordLlmTelemetryEvent(buildStartedEvent(model, context, options, scope, ids, rawPayload));

  void (async () => {
    try {
      for await (const event of inner) {
        if (!firstTokenAt && isFirstTokenCandidate(event)) {
          firstTokenAt = Date.now();
          recordLlmTelemetryEvent(firstTokenEvent(model, scope, ids, startedAt));
        }
        if (event.type === "done") recordLlmTelemetryEvent(finishedEvent(model, event.message, scope, ids, startedAt, firstTokenAt, responseHeaders));
        if (event.type === "error") recordLlmTelemetryEvent(failedEvent(model, event.error, scope, ids, startedAt, firstTokenAt));
        out.push(event);
      }
    } catch (err) {
      const message = makeErrorMessage(model, err);
      recordLlmTelemetryEvent(failedEvent(model, message, scope, ids, startedAt, firstTokenAt, err));
      out.push({ type: "error", reason: "error", error: message });
    }
  })();

  return out;
}

export function createTelemetryStreamFn(scope: LlmTelemetryScope): StreamFn {
  return (model, context, options) => streamSimpleWithTelemetry(model, context, options, scope);
}

export async function completeSimpleWithTelemetry<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  scope: LlmTelemetryScope,
): Promise<AssistantMessage> {
  return streamSimpleWithTelemetry(model, context, options, scope).result();
}
