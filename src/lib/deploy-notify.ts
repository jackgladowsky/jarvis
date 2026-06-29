import { execSync } from "node:child_process";
import { readFile, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

/**
 * Send a Telegram message via the bot API using native fetch. Throws on failure.
 */
async function sendTelegramMessage(text: string, chatId: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN not set");
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram API ${res.status}: ${body}`);
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

  // Build the message in JARVIS's voice — this is sent directly to the owner
  // via Telegram API, no notification pump delay.
  const lines: string[] = [`Hey Jack — just restarted to **v${version}** (\`${short(deploy.new_rev)}\`).`];

  if (changes.length > 0) {
    lines.push("");
    lines.push("*Since last deploy:*");
    for (const c of changes.slice(0, 5)) {
      const msg = c.replace(/^[0-9a-f]+\s+/, "");
      lines.push(`• ${msg}`);
    }
    if (changes.length > 5) {
      lines.push(`… and ${changes.length - 5} more commits`);
    }
  }

  const message = lines.join("\n");
  const chatId = config.scheduler.telegram_chat_id;

  try {
    await sendTelegramMessage(message, chatId);
    await rename(marker, join(dirname(marker), `completed-${Date.now()}.json`));
  } catch (err) {
    log.warn("deploy completion notification failed, falling back to internal notification", err);
    // Fallback: queue internal notification so it gets delivered on next user message
    const { enqueueInternalNotification } = await import("./internal-notifications.js");
    await enqueueInternalNotification({
      source: "deploy",
      chat_id: chatId,
      title: `JARVIS back online (v${version})`,
      body: message,
      prompt: message,
      fallback_text: `JARVIS back online: v${version} (${short(deploy.old_rev)} → ${short(deploy.new_rev)})`,
    });
    await rm(marker, { force: true });
  }
}
