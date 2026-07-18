import { randomUUID } from "node:crypto";

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_DELAY_MS = 30_000;

export class TelegramHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramHttpError";
  }
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

export function telegramRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof TelegramHttpError && error.retryAfterSeconds !== undefined) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, error.retryAfterSeconds * 1_000));
  }

  const parameters = objectValue(error, "parameters");
  const retryAfter = objectValue(parameters, "retry_after");
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAfter * 1_000));
  }

  const description = objectValue(error, "description");
  const message = typeof description === "string" ? description : error instanceof Error ? error.message : "";
  const match = message.match(/retry after\s+(\d+)/i);
  if (match) return Math.min(MAX_RETRY_DELAY_MS, Number(match[1]) * 1_000);
  const cause = objectValue(error, "cause") ?? objectValue(error, "error");
  return cause && cause !== error ? telegramRetryAfterMs(cause) : undefined;
}

export function isRetryableTelegramError(error: unknown): boolean {
  if (error instanceof TelegramHttpError) return error.status === 429 || error.status >= 500;

  const errorCode = objectValue(error, "error_code");
  if (errorCode === 429 || (typeof errorCode === "number" && errorCode >= 500)) return true;

  const code = objectValue(error, "code");
  if (
    typeof code === "string" &&
    ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"].includes(code)
  ) {
    return true;
  }

  if (error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError")) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/(network request|fetch failed|socket|timed? ?out|connection reset)/.test(message)) return true;
  const cause = objectValue(error, "cause") ?? objectValue(error, "error");
  return Boolean(cause && cause !== error && isRetryableTelegramError(cause));
}

function retryDelayMs(error: unknown, attempt: number): number {
  return telegramRetryAfterMs(error) ?? Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** Math.max(0, attempt - 1));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TelegramChunkLifecycleRecord {
  chunkId: string;
  index: number;
  total: number;
  outcome: "start" | "ok" | "error";
  durationMs?: number;
  error?: unknown;
}

/** Pair a Telegram chunk's start with one terminal event under a stable ID. */
export async function withTelegramChunkLifecycle<T>(
  operation: () => Promise<T>,
  options: {
    index: number;
    total: number;
    onEvent: (record: TelegramChunkLifecycleRecord) => void | Promise<void>;
    chunkId?: string;
  },
): Promise<T> {
  const chunkId = options.chunkId ?? randomUUID();
  const started = Date.now();
  const base = { chunkId, index: options.index, total: options.total };
  await options.onEvent({ ...base, outcome: "start" });
  try {
    const result = await operation();
    await options.onEvent({ ...base, outcome: "ok", durationMs: Date.now() - started });
    return result;
  } catch (error) {
    await options.onEvent({ ...base, outcome: "error", durationMs: Date.now() - started, error });
    throw error;
  }
}

/** Retry only Telegram throttling, server, timeout, and network failures. */
export async function withTelegramRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    onRetry?: (details: { attempt: number; delayMs: number; error: unknown }) => void | Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableTelegramError(error)) throw error;
      const delayMs = retryDelayMs(error, attempt);
      await options.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs);
    }
  }
  throw lastError;
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}

/** Read a response body without ever buffering more than maxBytes. */
export async function readResponseBodyLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`response is too large (${declaredLength} bytes; max ${maxBytes})`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response exceeded byte limit").catch(() => undefined);
        throw new Error(`response is too large (more than ${maxBytes} bytes)`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
