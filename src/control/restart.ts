import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { atomicWriteJson } from "../lib/durable-file.js";
import { enqueueInternalNotification } from "../lib/internal-notifications.js";
import { paths } from "../paths.js";
import { config, env } from "../config.js";
import { log } from "../lib/logger.js";

const execFileAsync = promisify(execFile);
const BACKGROUND_ENV = ["JARVIS_BACKGROUND_BOOTSTRAPPED", "JARVIS_BACKGROUND_WORKTREE", "JARVIS_WORKTREE"];

interface RestartMarker {
  requested_at: string;
  reason: string;
  revision: string;
  chat_id: number;
}

export interface RestartDependencies {
  platform?: NodeJS.Platform;
  exec?: typeof execFileAsync;
  detach?: (delaySeconds: number) => void;
  /** Test seam; null explicitly represents no safe notification destination. */
  notificationChatId?: number | null;
}

function assertMainProcess(): void {
  const active = BACKGROUND_ENV.find((name) => process.env[name]);
  if (active) throw new Error(`Restart refused in background context (${active})`);
}

function detachRestart(delaySeconds: number): void {
  const child = spawn("/bin/bash", ["-c", `sleep ${delaySeconds}; exec sudo -n systemctl restart jarvis.service`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function configuredNotificationChatId(override: number | null | undefined): number {
  const configured =
    override !== undefined
      ? override
      : config.scheduler.telegram_chat_id !== 0
        ? config.scheduler.telegram_chat_id
        : (() => {
            const ids = [
              ...new Set(env.TELEGRAM_ALLOWED_USER_IDS.split(",").map((value) => Number(value.trim()))),
            ].filter((value) => Number.isSafeInteger(value) && value > 0);
            return ids.length === 1 ? ids[0] : null;
          })();
  if (configured === null || !Number.isSafeInteger(configured) || configured === 0) {
    throw new Error(
      "Restart refused: configure scheduler.telegram_chat_id or exactly one Telegram allowlisted owner for the back-online notice",
    );
  }
  return configured;
}

export async function scheduleJarvisRestart(
  reason: string,
  revision: string,
  delaySeconds = 5,
  dependencies: RestartDependencies = {},
): Promise<void> {
  assertMainProcess();
  if (!reason.trim() || reason.length > 240) throw new Error("Restart reason must be 1-240 characters");
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("A full config revision is required");
  if (!Number.isInteger(delaySeconds) || delaySeconds < 3 || delaySeconds > 60)
    throw new Error("Restart delay must be 3-60 seconds");
  if ((dependencies.platform ?? process.platform) !== "linux")
    throw new Error("Service restart is supported only on Linux");
  // Resolve and bind delivery before touching service state. A restart must not
  // be scheduled if its promised back-online notice has nowhere valid to go.
  const chatId = configuredNotificationChatId(dependencies.notificationChatId);

  const exec = dependencies.exec ?? execFileAsync;
  await exec("sudo", ["-n", "systemctl", "show", "jarvis.service", "--property=LoadState", "--value"], {
    timeout: 5_000,
  }).then(({ stdout }) => {
    if (stdout.trim() !== "loaded") throw new Error("jarvis.service is not loaded");
  });
  await exec("sudo", ["-n", "-l", "systemctl", "restart", "jarvis.service"], { timeout: 5_000 });

  await atomicWriteJson(paths.configRestartPending, {
    requested_at: new Date().toISOString(),
    reason: reason.trim(),
    revision,
    chat_id: chatId,
  } satisfies RestartMarker);
  try {
    (dependencies.detach ?? detachRestart)(delaySeconds);
  } catch (err) {
    await rm(paths.configRestartPending, { force: true });
    throw err;
  }
}

export async function notifyPendingConfigRestart(): Promise<void> {
  let marker: RestartMarker;
  try {
    marker = JSON.parse(await readFile(paths.configRestartPending, "utf-8")) as RestartMarker;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn("config restart marker unreadable", err);
    return;
  }
  const chatId = marker.chat_id;
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    log.warn("config restart marker has no valid notification destination; discarding", {
      requestedAt: marker.requested_at,
    });
    await rm(paths.configRestartPending, { force: true });
    return;
  }
  const text = `JARVIS is back online after applying configuration changes.\nReason: ${marker.reason}`;
  await enqueueInternalNotification({
    id: `config-restart-${marker.requested_at}`,
    source: "deploy",
    chat_id: chatId,
    title: "JARVIS configuration applied",
    body: text,
    fallback_text: text,
  });
  await rm(paths.configRestartPending, { force: true });
}
