import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { z } from "zod";
import { runScheduledPrompt } from "./agent/runtime.js";
import { config } from "./config.js";
import { builtInScheduledTasks } from "./scheduled-defaults.js";
import { notifyMainOrFallback } from "./lib/internal-notifications.js";
import { isOneTimeTask, shouldNotify, taskSignature, type OneTimeTask, type RecurringTask, type SchedulerJob } from "./scheduler-logic.js";
import { log } from "./lib/logger.js";
import { paths } from "./paths.js";

interface ActiveScheduledJob {
  cronJob?: ScheduledTask;
  timeout?: NodeJS.Timeout;
  signature: string;
}

const BaseTaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1),
  prompt: z.string().min(1),
  notify: z.enum(["always", "on_issue", "never"]),
});

const RecurringTaskSchema = BaseTaskSchema.extend({
  schedule: z.string().min(1),
});

const OneTimeTaskSchema = BaseTaskSchema.extend({
  run_at: z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "run_at must be a valid date/time string",
  }),
});

const DynamicTaskSchema = z.union([
  RecurringTaskSchema.strict(),
  OneTimeTaskSchema.strict(),
]);

const DynamicTasksFileSchema = z.object({
  tasks: z.array(DynamicTaskSchema),
});

const TASK_RELOAD_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const activeJobs = new Map<string, ActiveScheduledJob>();

type DynamicTask = z.infer<typeof DynamicTaskSchema>;

function taskNotePath(task: SchedulerJob): string {
  return join(paths.scheduledJobNotes, `${task.id}.md`);
}

async function ensureTaskNote(task: SchedulerJob): Promise<string> {
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
        isOneTimeTask(task) ? "**Status:** pending" : "**Status:** active",
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

async function readDynamicTasksFile(): Promise<z.infer<typeof DynamicTasksFileSchema>> {
  await ensureTasksFile();
  const raw = await readFile(paths.scheduledJobTasks, "utf-8");
  const parsed = DynamicTasksFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid scheduled tasks file at ${paths.scheduledJobTasks}: ${parsed.error}`);
  }
  return parsed.data;
}

async function loadDynamicTasks(): Promise<DynamicTask[]> {
  return (await readDynamicTasksFile()).tasks;
}

async function removeOneTimeTask(id: string): Promise<void> {
  const file = await readDynamicTasksFile();
  const tasks = file.tasks.filter((task) => !(task.id === id && "run_at" in task));
  if (tasks.length === file.tasks.length) return;
  await writeFile(
    paths.scheduledJobTasks,
    JSON.stringify({ tasks }, null, 2) + "\n",
    "utf-8",
  );
  stopTask(id);
  await schedulerLog(`[${id}] removed one-time task`);
}

async function loadTasks(): Promise<SchedulerJob[]> {
  const byId = new Map<string, SchedulerJob>();
  for (const task of builtInScheduledTasks) byId.set(task.id, task);
  for (const task of config.scheduler.tasks) byId.set(task.id, task);
  for (const task of await loadDynamicTasks()) byId.set(task.id, task);
  return [...byId.values()];
}

async function runTask(task: SchedulerJob): Promise<void> {
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
      await notifyMainOrFallback({
        source: "scheduler",
        chat_id: config.scheduler.telegram_chat_id,
        title: task.name,
        body: message,
        prompt: message,
        fallback_text: message,
      });
      await schedulerLog(`[${task.id}] notification queued`);
    } catch (err) {
      await schedulerLog(
        `[${task.id}] notification queue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (isOneTimeTask(task)) {
    await removeOneTimeTask(task.id);
  }
}

function stopTask(id: string): void {
  const active = activeJobs.get(id);
  if (!active) return;
  if (active.cronJob) {
    void active.cronJob.stop();
    void active.cronJob.destroy();
  }
  if (active.timeout) clearTimeout(active.timeout);
  activeJobs.delete(id);
}

async function registerRecurringTask(task: RecurringTask): Promise<void> {
  if (!cron.validate(task.schedule)) {
    await schedulerLog(`[${task.id}] invalid cron expression: ${task.schedule}`);
    return;
  }

  await ensureTaskNote(task);
  const signature = taskSignature(task);
  const existing = activeJobs.get(task.id);
  if (existing?.signature === signature) return;
  stopTask(task.id);

  const cronJob = cron.schedule(
    task.schedule,
    () => runTask(task),
    {
      timezone: config.scheduler.timezone,
      name: task.id,
      noOverlap: true,
    },
  );
  activeJobs.set(task.id, { cronJob, signature });
  await schedulerLog(`[${task.id}] registered: ${task.name} @ ${task.schedule}`);
}

async function registerOneTimeTask(task: OneTimeTask): Promise<void> {
  await ensureTaskNote(task);
  const runAt = Date.parse(task.run_at);
  if (Number.isNaN(runAt)) {
    await schedulerLog(`[${task.id}] invalid run_at: ${task.run_at}`);
    return;
  }

  const signature = taskSignature(task);
  const existing = activeJobs.get(task.id);
  if (existing?.signature === signature) return;
  stopTask(task.id);

  const delay = runAt - Date.now();
  const timeout = setTimeout(
    () => {
      if (Date.now() < runAt) {
        activeJobs.delete(task.id);
        void registerOneTimeTask(task).catch((err) =>
          schedulerLog(`[${task.id}] one-time reschedule failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      void runTask(task).catch((err) =>
        schedulerLog(`[${task.id}] one-time run failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
    Math.max(0, Math.min(delay, MAX_TIMEOUT_MS)),
  );
  activeJobs.set(task.id, { timeout, signature });

  const when = delay <= 0 ? "now" : new Date(runAt).toISOString();
  await schedulerLog(`[${task.id}] registered one-time: ${task.name} @ ${when}`);
}

async function registerTask(task: SchedulerJob): Promise<void> {
  if (isOneTimeTask(task)) {
    await registerOneTimeTask(task);
  } else {
    await registerRecurringTask(task);
  }
}

async function reloadTasks(): Promise<void> {
  const tasks = await loadTasks();
  const seen = new Set(tasks.map((task) => task.id));

  for (const id of [...activeJobs.keys()]) {
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
    for (const id of [...activeJobs.keys()]) stopTask(id);
  };
}
