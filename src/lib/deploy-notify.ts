import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { enqueueInternalNotification } from "./internal-notifications.js";
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
    await enqueueInternalNotification({
      source: "deploy",
      chat_id: config.scheduler.telegram_chat_id,
      title: "JARVIS back online",
      body: message,
      prompt: message,
      fallback_text: message,
    });
    await rename(marker, join(dirname(marker), `completed-${Date.now()}.json`));
  } catch (err) {
    log.warn("deploy completion notification failed", err);
    // Avoid spamming every restart forever. The marker is best-effort UX, not
    // deploy state of record.
    await rm(marker, { force: true });
  }
}
