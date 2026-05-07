import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { z } from "zod";
import { runScheduledPrompt } from "./agent/runtime.js";
import { config, env, type Config } from "./config.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "./lib/format.js";
import { log } from "./lib/logger.js";
import { paths } from "./paths.js";

type SchedulerTask = Config["scheduler"]["tasks"][number];

interface ActiveScheduledTask {
  job: ScheduledTask;
  signature: string;
}

const DynamicTaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  notify: z.enum(["always", "on_issue", "never"]),
});

const DynamicTasksFileSchema = z.object({
  tasks: z.array(DynamicTaskSchema),
});

const TASK_RELOAD_MS = 30_000;
const activeTasks = new Map<string, ActiveScheduledTask>();

function taskSignature(task: SchedulerTask): string {
  return JSON.stringify({
    name: task.name,
    schedule: task.schedule,
    prompt: task.prompt,
    notify: task.notify,
  });
}

function taskNotePath(task: SchedulerTask): string {
  return join(paths.scheduledJobNotes, `${task.id}.md`);
}

async function ensureTaskNote(task: SchedulerTask): Promise<string> {
  await mkdir(paths.scheduledJobNotes, { recursive: true });
  const path = taskNotePath(task);
  try {
    await readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeFile(
      path,
      [
        `# ${task.name}`,
        "",
        `**Task ID:** ${task.id}`,
        "**Status:** active",
        "**Last run:** never",
        "",
        "## Latest",
        "No runs yet.",
        "",
        "## Observations",
        "- None yet.",
        "",
        "## Watch",
        "- Initial run output.",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
  return path;
}

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

async function ensureTasksFile(): Promise<void> {
  await mkdir(paths.scheduledJobs, { recursive: true });
  try {
    await readFile(paths.scheduledJobTasks, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await writeFile(
      paths.scheduledJobTasks,
      JSON.stringify({ tasks: [] }, null, 2) + "\n",
      "utf-8",
    );
  }
}

async function loadDynamicTasks(): Promise<SchedulerTask[]> {
  await ensureTasksFile();
  const raw = await readFile(paths.scheduledJobTasks, "utf-8");
  const parsed = DynamicTasksFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid scheduled tasks file at ${paths.scheduledJobTasks}: ${parsed.error}`);
  }
  return parsed.data.tasks;
}

async function loadTasks(): Promise<SchedulerTask[]> {
  const byId = new Map<string, SchedulerTask>();
  for (const task of config.scheduler.tasks) byId.set(task.id, task);
  for (const task of await loadDynamicTasks()) byId.set(task.id, task);
  return [...byId.values()];
}

function formatNotification(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  const mode = config.telegram.parse_mode;
  if (mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" };
  return { text };
}

async function sendTelegram(chatId: number, text: string): Promise<void> {
  for (const chunk of splitTelegramMarkdown(text)) {
    const formatted = formatNotification(chunk);
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatted.text,
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
    }
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
    const notePath = await ensureTaskNote(task);
    output = await runScheduledPrompt(task.id, task.name, task.prompt, notePath);
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

function stopTask(id: string): void {
  const active = activeTasks.get(id);
  if (!active) return;
  void active.job.stop();
  void active.job.destroy();
  activeTasks.delete(id);
}

async function registerTask(task: SchedulerTask): Promise<void> {
  if (!cron.validate(task.schedule)) {
    await schedulerLog(`[${task.id}] invalid cron expression: ${task.schedule}`);
    return;
  }

  await ensureTaskNote(task);
  const signature = taskSignature(task);
  const existing = activeTasks.get(task.id);
  if (existing?.signature === signature) return;
  stopTask(task.id);

  const job = cron.schedule(
    task.schedule,
    () => runTask(task),
    {
      timezone: config.scheduler.timezone,
      name: task.id,
      noOverlap: true,
    },
  );
  activeTasks.set(task.id, { job, signature });
  await schedulerLog(`[${task.id}] registered: ${task.name} @ ${task.schedule}`);
}

async function reloadTasks(): Promise<void> {
  const tasks = await loadTasks();
  const seen = new Set(tasks.map((task) => task.id));

  for (const id of [...activeTasks.keys()]) {
    if (!seen.has(id)) {
      stopTask(id);
      await schedulerLog(`[${id}] unregistered`);
    }
  }

  for (const task of tasks) {
    await registerTask(task);
  }
}

export async function startScheduler(): Promise<() => void> {
  if (!config.scheduler.enabled) {
    log.info("scheduler disabled");
    return () => {};
  }

  await mkdir(paths.scheduledJobSessions, { recursive: true });
  await mkdir(paths.scheduledJobNotes, { recursive: true });
  await ensureTasksFile();
  await schedulerLog("scheduler starting");
  await reloadTasks();

  let reloading = false;
  const reloadTimer = setInterval(() => {
    if (reloading) return;
    reloading = true;
    void reloadTasks()
      .catch((err) => schedulerLog(`reload failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        reloading = false;
      });
  }, TASK_RELOAD_MS);

  return () => {
    clearInterval(reloadTimer);
    for (const id of [...activeTasks.keys()]) stopTask(id);
  };
}
