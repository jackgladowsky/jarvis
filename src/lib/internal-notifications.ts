import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { config, env } from "../config.js";
import { paths } from "../paths.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "./format.js";
import { log } from "./logger.js";
import { readProcessStartTime } from "./process-identity.js";
import { atomicWriteJson, withFileLock } from "./durable-file.js";
import { fetchWithTimeout, TelegramHttpError, withTelegramRetry } from "./telegram-delivery.js";

export type InternalNotificationSource = "background" | "scheduler" | "deploy" | "system";

export interface InternalNotification {
  id: string;
  source: InternalNotificationSource;
  chat_id: number;
  title: string;
  body: string;
  prompt?: string;
  fallback_text?: string;
  created_at: string;
  status: "pending" | "running" | "processed" | "failed";
  updated_at?: string;
  error?: string;
  attempts?: number;
  max_attempts?: number;
  next_attempt_at?: string;
  /** Identifies the atomically renamed in-flight queue file. */
  claim_token?: string;
  claim_owner_pid?: number;
  claim_owner_start_time?: string;
}

const HEARTBEAT_MAX_AGE_MS = 30_000;
const RUNNING_NOTIFICATION_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const TELEGRAM_TIMEOUT_MS = 15_000;

export class InternalNotificationClaimLostError extends Error {
  constructor(id: string) {
    super(`internal notification claim was lost: ${id}`);
    this.name = "InternalNotificationClaimLostError";
  }
}

export class TelegramPartialDeliveryError extends Error {
  constructor(cause: unknown) {
    super("Telegram delivery failed after at least one chunk was sent", { cause });
    this.name = "TelegramPartialDeliveryError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function idPart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "notification";

  // Keep existing short, filename-safe IDs stable for upgrade compatibility.
  // Whenever normalization or truncation would be lossy, retain a digest of
  // the original value so two distinct caller IDs cannot silently alias the
  // same durable queue record.
  if (normalized === value && normalized.length <= 48) return normalized;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${normalized.slice(0, 31)}-${digest}`;
}

function notificationPath(id: string): string {
  return join(paths.internalNotifications, `${id}.json`);
}

function runningNotificationPath(id: string, claimToken: string): string {
  return join(paths.internalNotifications, `${id}.${claimToken}.running.json`);
}

function runningNameParts(name: string): { id: string; claimToken: string } | undefined {
  const match = name.match(/^(.+)\.([0-9a-f-]{36})\.running\.json$/i);
  return match ? { id: match[1], claimToken: match[2] } : undefined;
}

export function renderInternalNotificationPrompt(notification: InternalNotification): string {
  return [
    `Internal ${notification.source} notification: ${notification.title}`,
    "",
    "Handle this as main JARVIS in the current Telegram conversation. Respond to the owner normally; do not mention internal routing unless it matters.",
    "",
    notification.prompt ?? notification.body,
  ].join("\n");
}

export async function writeInternalNotificationHeartbeat(): Promise<void> {
  await mkdir(paths.internalNotifications, { recursive: true });
  await atomicWriteJson(paths.internalNotificationsHeartbeat, { pid: process.pid, updated_at: now() });
}

export async function mainNotificationPumpLooksAlive(maxAgeMs = HEARTBEAT_MAX_AGE_MS): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(paths.internalNotificationsHeartbeat, "utf-8")) as { updated_at?: string };
    if (!parsed.updated_at) return false;
    const updated = Date.parse(parsed.updated_at);
    return Number.isFinite(updated) && Date.now() - updated <= maxAgeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("internal notification heartbeat read failed", err);
    }
    return false;
  }
}

export async function enqueueInternalNotification(
  input: Omit<InternalNotification, "id" | "created_at" | "status"> & { id?: string },
): Promise<InternalNotification> {
  await mkdir(paths.internalNotifications, { recursive: true });
  const requestedId = input.id ? idPart(input.id) : undefined;
  const id = requestedId ?? `${Date.now()}-${process.pid}-${idPart(input.source)}-${randomUUID()}`;
  return withFileLock(notificationPath(id), async () => {
    if (requestedId) {
      const existing = await findInternalNotification(id);
      if (existing) return existing;
    }
    const notification: InternalNotification = {
      ...input,
      id,
      created_at: now(),
      status: "pending",
      attempts: input.attempts ?? 0,
      max_attempts: input.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
    };
    await atomicWriteJson(notificationPath(notification.id), notification);
    return notification;
  });
}

async function readNotificationIfPresent(path: string): Promise<InternalNotification | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as InternalNotification;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function findInternalNotification(id: string): Promise<InternalNotification | undefined> {
  const pending = await readNotificationIfPresent(notificationPath(id));
  if (pending) return pending;

  const names = await readdir(paths.internalNotifications);
  const runningName = names.find((name) => runningNameParts(name)?.id === id);
  if (runningName) {
    const parts = runningNameParts(runningName)!;
    const running = await readNotificationIfPresent(join(paths.internalNotifications, runningName));
    if (running) return { ...running, id, status: "running", claim_token: parts.claimToken };
  }

  for (const status of ["processed", "failed"] as const) {
    const archived = await readNotificationIfPresent(join(paths.internalNotificationsArchive, `${status}-${id}.json`));
    if (archived) return { ...archived, id, status };
  }
  return undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runningNotificationCanBeReclaimed(
  notification: InternalNotification,
  maxAgeMs = RUNNING_NOTIFICATION_MAX_AGE_MS,
): Promise<boolean> {
  if (notification.status !== "running") return false;
  const updated = Date.parse(notification.updated_at ?? notification.created_at);
  if (Number.isFinite(updated) && Date.now() - updated <= maxAgeMs) return false;
  if (notification.claim_owner_pid && notification.claim_owner_start_time) {
    const observed = await readProcessStartTime(notification.claim_owner_pid);
    return observed !== notification.claim_owner_start_time;
  }
  // Legacy claims get the same age grace, then PID liveness prevents stealing
  // a paused but still-owned delivery. New claims always carry start identity.
  if (notification.claim_owner_pid && processIsAlive(notification.claim_owner_pid)) return false;
  return true;
}

function isDue(notification: InternalNotification): boolean {
  if (!notification.next_attempt_at) return true;
  const next = Date.parse(notification.next_attempt_at);
  return !Number.isFinite(next) || next <= Date.now();
}

export async function listPendingInternalNotifications(): Promise<InternalNotification[]> {
  await mkdir(paths.internalNotifications, { recursive: true });
  const names = (await readdir(paths.internalNotifications))
    .filter((name) => name.endsWith(".json") && name !== "heartbeat.json")
    .sort();
  const notifications: InternalNotification[] = [];
  for (const name of names) {
    try {
      const runningParts = runningNameParts(name);
      const parsed = JSON.parse(
        await readFile(join(paths.internalNotifications, name), "utf-8"),
      ) as InternalNotification;
      const notification = runningParts
        ? { ...parsed, id: runningParts.id, claim_token: runningParts.claimToken, status: "running" as const }
        : parsed;
      if (
        (notification.status === "pending" && isDue(notification)) ||
        (await runningNotificationCanBeReclaimed(notification))
      ) {
        notifications.push(notification);
      }
    } catch (err) {
      log.warn("internal notification read failed", { file: name, err: err instanceof Error ? err.message : err });
    }
  }
  return notifications.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Rename is the claim: across multiple JARVIS processes only one claimant can win it. */
export async function claimInternalNotification(
  notification: InternalNotification,
): Promise<InternalNotification | undefined> {
  const ownerStartTime = await readProcessStartTime(process.pid);
  return withFileLock(notificationPath(notification.id), async () => {
    const source = notification.claim_token
      ? runningNotificationPath(notification.id, notification.claim_token)
      : notificationPath(notification.id);
    const claimToken = randomUUID();
    const target = runningNotificationPath(notification.id, claimToken);
    try {
      await rename(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("internal notification claim failed", {
          id: notification.id,
          err: err instanceof Error ? err.message : err,
        });
      }
      return undefined;
    }

    const claimed: InternalNotification = {
      ...notification,
      status: "running",
      updated_at: now(),
      attempts: (notification.attempts ?? 0) + 1,
      claim_token: claimToken,
      claim_owner_pid: process.pid,
      claim_owner_start_time: ownerStartTime,
      next_attempt_at: undefined,
    };
    await atomicWriteJson(target, claimed);
    return claimed;
  });
}

export async function renewInternalNotificationClaim(notification: InternalNotification): Promise<void> {
  if (!notification.claim_token) return;
  await withFileLock(notificationPath(notification.id), async () => {
    const runningPath = runningNotificationPath(notification.id, notification.claim_token!);
    const stored = await readNotificationIfPresent(runningPath);
    if (!stored || stored.claim_token !== notification.claim_token) {
      throw new InternalNotificationClaimLostError(notification.id);
    }
    notification.updated_at = now();
    await atomicWriteJson(runningPath, notification);
  });
}

export function internalNotificationRetryDelayMs(attempts: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export async function finishInternalNotification(
  notification: InternalNotification,
  status: "processed" | "failed",
  error?: string,
): Promise<void> {
  await withFileLock(notificationPath(notification.id), async () => {
    const current = notification.claim_token
      ? runningNotificationPath(notification.id, notification.claim_token)
      : notificationPath(notification.id);
    const stored = await readNotificationIfPresent(current);
    if (!stored || (notification.claim_token && stored.claim_token !== notification.claim_token)) {
      throw new InternalNotificationClaimLostError(notification.id);
    }
    const attempts = notification.attempts ?? 0;
    const maxAttempts = notification.max_attempts ?? DEFAULT_MAX_ATTEMPTS;

    if (status === "failed" && attempts < maxAttempts) {
      const retry: InternalNotification = {
        ...notification,
        status: "pending",
        updated_at: now(),
        error,
        claim_token: undefined,
        claim_owner_pid: undefined,
        claim_owner_start_time: undefined,
        next_attempt_at: new Date(Date.now() + internalNotificationRetryDelayMs(attempts)).toISOString(),
      };
      await atomicWriteJson(current, retry);
      await rename(current, notificationPath(notification.id));
      return;
    }

    const finished: InternalNotification = {
      ...notification,
      status,
      updated_at: now(),
      error,
      claim_token: undefined,
      claim_owner_pid: undefined,
      claim_owner_start_time: undefined,
      next_attempt_at: undefined,
    };
    const target = join(paths.internalNotificationsArchive, `${status}-${notification.id}.json`);
    await mkdir(paths.internalNotificationsArchive, { recursive: true });
    // The move out of the live queue is the terminal commit point. If the
    // following metadata rewrite is interrupted, the running payload is still
    // under an archive filename and can never be reclaimed/redelivered.
    await rename(current, target);
    await atomicWriteJson(target, finished);
  });
}

function formatNotification(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  const mode = config.telegram.parse_mode;
  if (mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" };
  return { text };
}

async function sendTelegramFallbackChunk(chatId: number, text: string): Promise<void> {
  const formatted = formatNotification(text);
  const send = async (plainText: boolean): Promise<void> => {
    await withTelegramRetry(async () => {
      const response = await fetchWithTimeout(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: plainText ? text : formatted.text,
            parse_mode: plainText ? undefined : formatted.parse_mode,
            link_preview_options: { is_disabled: true },
          }),
        },
        TELEGRAM_TIMEOUT_MS,
      );
      if (!response.ok) {
        const body = await response.text();
        let retryAfter: number | undefined;
        try {
          retryAfter = (JSON.parse(body) as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        } catch {
          // Telegram occasionally returns a non-JSON gateway response.
        }
        throw new TelegramHttpError(
          response.status,
          `Telegram sendMessage failed: ${response.status} ${body}`,
          retryAfter,
        );
      }
    });
  };

  try {
    await send(false);
  } catch (err) {
    if (!formatted.parse_mode) throw err;
    log.warn("formatted Telegram fallback failed; retrying as plain text", {
      err: err instanceof Error ? err.message : err,
    });
    await send(true);
  }
}

export async function sendTelegramFallback(chatId: number, text: string): Promise<void> {
  let sentChunks = 0;
  for (const chunk of splitTelegramMarkdown(text)) {
    try {
      await sendTelegramFallbackChunk(chatId, chunk);
      sentChunks += 1;
    } catch (err) {
      if (sentChunks > 0) throw new TelegramPartialDeliveryError(err);
      throw err;
    }
  }
}

export async function notifyMainOrFallback(
  input: Omit<InternalNotification, "id" | "created_at" | "status"> & { id?: string },
): Promise<InternalNotification> {
  const notification = await enqueueInternalNotification(input);
  if (notification.status !== "pending" || !isDue(notification)) return notification;
  if (await mainNotificationPumpLooksAlive()) return notification;

  const fallback = input.fallback_text ?? `[${input.source}] ${input.title}\n\n${input.body}`;
  const claimed = await claimInternalNotification(notification);
  if (!claimed) return notification;
  try {
    await sendTelegramFallback(input.chat_id, fallback);
  } catch (err) {
    if (err instanceof TelegramPartialDeliveryError) {
      await finishInternalNotification(claimed, "processed").catch(() => undefined);
      log.error("partial Telegram fallback delivery; replay suppressed", { id: notification.id });
      return notification;
    }
    await finishInternalNotification(claimed, "failed", err instanceof Error ? err.message : String(err));
    log.warn("internal notification fallback failed; notification queued for retry", {
      id: notification.id,
      err: err instanceof Error ? err.message : err,
    });
    return notification;
  }
  // Delivery succeeded. A later state-write failure must never be mistaken
  // for a send failure, or the fallback path would duplicate visible output.
  await finishInternalNotification(claimed, "processed").catch((err) =>
    log.error("notification state commit failed after Telegram fallback delivery", {
      id: notification.id,
      err: err instanceof Error ? err.message : err,
    }),
  );
  log.warn("internal notification used Telegram fallback", {
    id: notification.id,
    source: input.source,
    title: input.title,
  });
  return notification;
}
