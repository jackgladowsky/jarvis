import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config, env } from "../config.js";
import { log } from "./logger.js";
import { paths } from "../paths.js";

type PendingDeploy = {
  started_at?: string;
  old_rev?: string;
  new_rev?: string;
  target_ref?: string;
};

function short(rev: string | undefined): string {
  return rev ? rev.slice(0, 7) : "unknown";
}

async function sendTelegram(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.scheduler.telegram_chat_id, text }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

export async function notifyPendingDeployComplete(): Promise<void> {
  const marker = paths.deployPending;
  let raw: string;
  try {
    raw = await readFile(marker, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("deploy marker read failed", err);
    }
    return;
  }

  let deploy: PendingDeploy = {};
  try {
    deploy = JSON.parse(raw) as PendingDeploy;
  } catch (err) {
    log.warn("deploy marker parse failed", err);
  }

  const message = [
    `JARVIS back online: ${short(deploy.old_rev)} → ${short(deploy.new_rev)}.`,
    deploy.target_ref ? `Target: ${deploy.target_ref}.` : undefined,
  ].filter(Boolean).join("\n");

  try {
    await sendTelegram(message);
    await rename(marker, join(dirname(marker), `completed-${Date.now()}.json`));
  } catch (err) {
    log.warn("deploy completion notification failed", err);
    // Avoid spamming every restart forever. The marker is best-effort UX, not
    // deploy state of record.
    await rm(marker, { force: true });
  }
}
