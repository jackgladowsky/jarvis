import { execSync } from "node:child_process";
import { readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

/** Read package.json version. Best-effort — returns "?" on failure. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(paths.repo, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

/** Get oneline commit summaries between old and new revs. */
function changesSummary(oldRev: string, newRev: string): string[] {
  try {
    const range = `${oldRev}..${newRev}`;
    const out = execSync(`git -C ${paths.repo} log --oneline --no-decorate ${range}`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
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

  const version = readVersion();
  const changes = deploy.old_rev && deploy.new_rev ? changesSummary(deploy.old_rev, deploy.new_rev) : [];

  // The notification pump wraps this in the "Handle this as main JARVIS"
  // preamble. The prompt text here is the final section — it's what the
  // model receives as the notification body. So write it as natural
  // JARVIS speech directed at the owner.
  const promptLines: string[] = [`Hey Jack — just restarted to v${version} (${short(deploy.new_rev)}).`];

  if (changes.length > 0) {
    promptLines.push("Since last deploy:", ...changes.slice(0, 5).map((c) => c.replace(/^[0-9a-f]+\s+/, "- ")));
    if (changes.length > 5) {
      promptLines.push(`… and ${changes.length - 5} more commits`);
    }
  }

  const prompt = promptLines.join("\n");

  const bodyLines: string[] = [`Deploy complete: now running v${version} (${short(deploy.new_rev)}). Changes:`];
  for (const line of changes.slice(0, 8)) {
    bodyLines.push(`  ${line}`);
  }
  if (changes.length > 8) {
    bodyLines.push(`  … and ${changes.length - 8} more`);
  }

  try {
    await enqueueInternalNotification({
      source: "deploy",
      chat_id: config.scheduler.telegram_chat_id,
      title: `JARVIS back online (v${version})`,
      body: bodyLines.join("\n"),
      prompt,
      fallback_text: `JARVIS back online: v${version} (${short(deploy.old_rev)} → ${short(deploy.new_rev)})`,
    });
    await rename(marker, join(dirname(marker), `completed-${Date.now()}.json`));
  } catch (err) {
    log.warn("deploy completion notification failed", err);
    // Avoid spamming every restart forever. The marker is best-effort UX, not
    // deploy state of record.
    await rm(marker, { force: true });
  }
}
