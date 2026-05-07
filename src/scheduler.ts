import { appendFile, mkdir } from "node:fs/promises";
import cron, { type ScheduledTask } from "node-cron";
import { runScheduledPrompt } from "./agent/runtime.js";
import { config, env, type Config } from "./config.js";
import { markdownToTelegramHtml } from "./lib/format.js";
import { log } from "./lib/logger.js";
import { paths } from "./paths.js";

type SchedulerTask = Config["scheduler"]["tasks"][number];

const activeTasks = new Map<string, ScheduledTask>();

async function schedulerLog(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  log.info(message);
  try {
    await mkdir(paths.scheduledJobs, { recursive: true });
    await appendFile(paths.scheduledJobsLog, line, "utf-8");
  } catch (err) {
    log.warn("scheduler log write failed", err);
  }
}

function formatNotification(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  const mode = config.telegram.parse_mode;
  if (mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" };
  return { text };
}

async function sendTelegram(chatId: number, text: string): Promise<void> {
  const formatted = formatNotification(text);
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatted.text,
        parse_mode: formatted.parse_mode,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

function shouldNotify(task: SchedulerTask, success: boolean, output: string): boolean {
  if (task.notify === "never") return false;
  if (task.notify === "always") return true;
  if (!success) return true;
  const lower = output.toLowerCase();
  return ["warning", "error", "critical", "down", "fail", "issue", "alert"].some((word) =>
    lower.includes(word),
  );
}

async function runTask(task: SchedulerTask): Promise<void> {
  const started = Date.now();
  let success = true;
  let output = "";

  await schedulerLog(`[${task.id}] starting: ${task.name}`);
  try {
    output = await runScheduledPrompt(task.id, task.name, task.prompt);
    await schedulerLog(`[${task.id}] completed (${output.length} chars)`);
  } catch (err) {
    success = false;
    output = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
    await schedulerLog(`[${task.id}] failed: ${output}`);
  }

  if (shouldNotify(task, success, output)) {
    const durationSec = Math.round((Date.now() - started) / 1000);
    const header = success
      ? `[Scheduler] ${task.name}`
      : `[Scheduler] ${task.name} — FAILED`;
    const message = `${header}\n\n${output}\n\n(${durationSec}s)`;
    try {
      await sendTelegram(config.scheduler.telegram_chat_id, message);
      await schedulerLog(`[${task.id}] notification sent`);
    } catch (err) {
      await schedulerLog(
        `[${task.id}] notification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function startScheduler(): Promise<() => void> {
  if (!config.scheduler.enabled) {
    log.info("scheduler disabled");
    return () => {};
  }

  await mkdir(paths.scheduledJobSessions, { recursive: true });
  await schedulerLog(`scheduler starting with ${config.scheduler.tasks.length} task(s)`);

  for (const task of config.scheduler.tasks) {
    if (!cron.validate(task.schedule)) {
      await schedulerLog(`[${task.id}] invalid cron expression: ${task.schedule}`);
      continue;
    }

    const scheduled = cron.schedule(
      task.schedule,
      () => {
        void runTask(task);
      },
      {
        timezone: config.scheduler.timezone,
        name: task.id,
        noOverlap: true,
      },
    );
    activeTasks.set(task.id, scheduled);
    await schedulerLog(`[${task.id}] registered: ${task.name} @ ${task.schedule}`);
  }

  return () => {
    for (const [id, task] of activeTasks) {
      void task.stop();
      void task.destroy();
      activeTasks.delete(id);
    }
  };
}
