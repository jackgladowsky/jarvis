import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { link, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { config } from "../config.js";
import { paths } from "../paths.js";
import { atomicWriteJson } from "./durable-file.js";
import { enqueueInternalNotification } from "./internal-notifications.js";
import { log } from "./logger.js";

interface PendingDeploy {
  started_at?: string;
  old_rev?: string;
  new_rev?: string;
  target_ref?: string;
  delivered_at?: string;
  notification_queued_at?: string;
}

function short(rev: string | undefined): string {
  return rev ? rev.slice(0, 7) : "unknown";
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(paths.repo, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

function isCommitId(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{7,64}$/i.test(value));
}

function changesSummary(oldRev: string | undefined, newRev: string | undefined): string[] {
  if (!isCommitId(oldRev) || !isCommitId(newRev)) return [];
  try {
    const output = execFileSync(
      "git",
      ["-C", paths.repo, "log", "--oneline", "--no-decorate", `${oldRev}..${newRev}`, "--"],
      {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function archiveMarker(marker: string, prefix: string): Promise<void> {
  const target = join(dirname(paths.deployPending), `${prefix}-${Date.now()}.json`);
  try {
    await rename(marker, target);
  } catch (err) {
    try {
      await rm(marker, { force: true });
    } catch (removeErr) {
      log.warn("deploy marker cleanup failed", {
        renameError: err instanceof Error ? err.message : err,
        removeError: removeErr instanceof Error ? removeErr.message : removeErr,
      });
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function recoverAbandonedMarkerClaim(): Promise<void> {
  const directory = dirname(paths.deployPending);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return;
  }
  for (const name of names.filter((candidate) => /^pending\.\d+\.[0-9a-f-]+\.running\.json$/i.test(candidate))) {
    const marker = join(directory, name);
    const pid = Number(name.split(".")[1]);
    const age = Date.now() - (await stat(marker)).mtimeMs;
    if (processIsAlive(pid) && age < 5 * 60_000) continue;
    try {
      await link(marker, paths.deployPending);
      await rm(marker, { force: true });
      return;
    } catch (err) {
      if (!["ENOENT", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        log.warn("abandoned deploy marker claim recovery failed", err);
      }
    }
  }
}

async function claimPendingMarker(): Promise<string | undefined> {
  const claim = join(dirname(paths.deployPending), `pending.${process.pid}.${randomUUID()}.running.json`);
  try {
    await rename(paths.deployPending, claim);
    return claim;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await recoverAbandonedMarkerClaim();
  try {
    await rename(paths.deployPending, claim);
    return claim;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function releaseMarkerClaim(marker: string): Promise<void> {
  try {
    await link(marker, paths.deployPending);
    await rm(marker, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      await archiveMarker(marker, "superseded");
      return;
    }
    log.error("deploy marker claim could not be released", err);
  }
}

function deployMessage(deploy: PendingDeploy): string {
  const changes = changesSummary(deploy.old_rev, deploy.new_rev);
  const lines = [`Hey Jack — back online, running v${readVersion()} (${short(deploy.new_rev)}).`];
  if (changes.length > 0) {
    lines.push("", "Since last deploy:");
    for (const change of changes.slice(0, 5)) lines.push(`• ${change.replace(/^[0-9a-f]+\s+/, "")}`);
    if (changes.length > 5) lines.push(`… and ${changes.length - 5} more commits`);
  }
  return lines.join("\n");
}

function deployNotificationId(deploy: PendingDeploy): string {
  // A revision is not an event identity: rolling back and later redeploying
  // the same commit must produce a fresh readiness notice. The persisted
  // marker tuple identifies one deploy while staying stable across recovery.
  const eventIdentity = JSON.stringify([
    deploy.started_at ?? "legacy",
    deploy.old_rev ?? "",
    deploy.new_rev ?? "",
    deploy.target_ref ?? "",
  ]);
  const digest = createHash("sha256").update(eventIdentity).digest("hex").slice(0, 16);
  return `deploy-complete-${short(deploy.new_rev)}-${digest}`;
}

/** Announce only marker-backed deploys, after Telegram polling is ready. */
export async function notifyPendingDeployComplete(): Promise<void> {
  const marker = await claimPendingMarker();
  if (!marker) return;
  let raw: string;
  try {
    raw = await readFile(marker, "utf-8");
  } catch (err) {
    log.warn("claimed deploy marker read failed", err);
    return;
  }

  let deploy: PendingDeploy;
  try {
    deploy = JSON.parse(raw) as PendingDeploy;
  } catch (err) {
    log.warn("deploy marker parse failed; archiving invalid marker", err);
    await archiveMarker(marker, "invalid");
    return;
  }

  // A previous startup completed delivery/queueing but crashed while cleaning
  // the marker. Never turn that cleanup failure into a duplicate message.
  if (deploy.delivered_at || deploy.notification_queued_at) {
    await archiveMarker(marker, "completed");
    return;
  }

  const chatId = config.scheduler.telegram_chat_id;
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    log.warn("deploy completion notification skipped: telegram_chat_id is not configured");
    await releaseMarkerClaim(marker);
    return;
  }

  const message = deployMessage(deploy);
  const notificationId = deployNotificationId(deploy);
  try {
    await enqueueInternalNotification({
      id: notificationId,
      source: "deploy",
      chat_id: chatId,
      title: `JARVIS back online (v${readVersion()})`,
      body: message,
      fallback_text: message,
    });
    deploy.notification_queued_at = new Date().toISOString();
    await atomicWriteJson(marker, deploy);
    await archiveMarker(marker, "queued");
  } catch (err) {
    // Keep the marker for the next healthy startup if durable queueing failed.
    log.error("startup deploy notification could not be queued", err);
    await releaseMarkerClaim(marker);
  }
}
