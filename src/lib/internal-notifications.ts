import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { config, env } from "../config.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "./format.js";
import { log } from "./logger.js";
import { paths } from "../paths.js";

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
}

const HEARTBEAT_MAX_AGE_MS = 30_000;
const RUNNING_NOTIFICATION_MAX_AGE_MS = 5 * 60_000;

function now(): string {
  return new Date().toISOString();
}

function idPart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "notification"
  );
}

function notificationPath(id: string): string {
  return join(paths.internalNotifications, `${id}.json`);
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
  await writeFile(
    paths.internalNotificationsHeartbeat,
    JSON.stringify({ pid: process.pid, updated_at: now() }, null, 2) + "\n",
    "utf-8",
  );
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
  const notification: InternalNotification = {
    ...input,
    id: input.id ?? `${Date.now()}-${process.pid}-${idPart(input.source)}-${idPart(input.title)}`,
    created_at: now(),
    status: "pending",
  };
  await writeFile(notificationPath(notification.id), JSON.stringify(notification, null, 2) + "\n", "utf-8");
  return notification;
}

function isStaleRunningNotification(
  notification: InternalNotification,
  maxAgeMs = RUNNING_NOTIFICATION_MAX_AGE_MS,
): boolean {
  if (notification.status !== "running") return false;
  const updated = Date.parse(notification.updated_at ?? notification.created_at);
  return !Number.isFinite(updated) || Date.now() - updated > maxAgeMs;
}

export async function listPendingInternalNotifications(): Promise<InternalNotification[]> {
  await mkdir(paths.internalNotifications, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const names = (await readdir(paths.internalNotifications))
    .filter((name) => name.endsWith(".json") && name !== "heartbeat.json")
    .sort();
  const notifications: InternalNotification[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(
        await readFile(join(paths.internalNotifications, name), "utf-8"),
      ) as InternalNotification;
      if (parsed.status === "pending" || isStaleRunningNotification(parsed)) notifications.push(parsed);
    } catch (err) {
      log.warn("internal notification read failed", { file: name, err: err instanceof Error ? err.message : err });
    }
  }
  return notifications.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function claimInternalNotification(
  notification: InternalNotification,
): Promise<InternalNotification | undefined> {
  const claimed: InternalNotification = { ...notification, status: "running", updated_at: now() };
  try {
    await writeFile(notificationPath(notification.id), JSON.stringify(claimed, null, 2) + "\n", "utf-8");
    return claimed;
  } catch (err) {
    log.warn("internal notification claim failed", {
      id: notification.id,
      err: err instanceof Error ? err.message : err,
    });
    return undefined;
  }
}

export async function finishInternalNotification(
  notification: InternalNotification,
  status: "processed" | "failed",
  error?: string,
): Promise<void> {
  const finished: InternalNotification = { ...notification, status, updated_at: now(), error };
  const current = notificationPath(notification.id);
  const target = join(paths.internalNotificationsArchive, `${status}-${basename(current)}`);
  await mkdir(paths.internalNotificationsArchive, { recursive: true });
  await writeFile(current, JSON.stringify(finished, null, 2) + "\n", "utf-8");
  await rename(current, target).catch(async (err) => {
    log.warn("internal notification archive failed", {
      id: notification.id,
      err: err instanceof Error ? err.message : err,
    });
  });
}

function formatNotification(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  const mode = config.telegram.parse_mode;
  if (mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" };
  return { text };
}

export async function sendTelegramFallback(chatId: number, text: string): Promise<void> {
  for (const chunk of splitTelegramMarkdown(text)) {
    const formatted = formatNotification(chunk);
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatted.text,
        parse_mode: formatted.parse_mode,
        link_preview_options: { is_disabled: true },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }
  }
}

export async function notifyMainOrFallback(
  input: Omit<InternalNotification, "id" | "created_at" | "status"> & { id?: string },
): Promise<InternalNotification> {
  const notification = await enqueueInternalNotification(input);
  if (await mainNotificationPumpLooksAlive()) return notification;

  const fallback = input.fallback_text ?? `[${input.source}] ${input.title}\n\n${input.body}`;
  try {
    await sendTelegramFallback(input.chat_id, fallback);
    await finishInternalNotification(notification, "processed");
    log.warn("internal notification used Telegram fallback", {
      id: notification.id,
      source: input.source,
      title: input.title,
    });
  } catch (err) {
    log.warn("internal notification fallback failed", {
      id: notification.id,
      err: err instanceof Error ? err.message : err,
    });
  }
  return notification;
}
