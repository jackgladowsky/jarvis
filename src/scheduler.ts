import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { z } from "zod";
import { isAgentRunAbortError } from "./agent/run-registry.js";
import { AgentExecutionError, runScheduledPrompt } from "./agent/runtime.js";
import { config } from "./config.js";
import { appendFileDurable, atomicWriteFile, atomicWriteJson, withFileLock } from "./lib/durable-file.js";
import { notifyMainOrFallback } from "./lib/internal-notifications.js";
import { log } from "./lib/logger.js";
import { paths } from "./paths.js";
import { builtInScheduledTasks } from "./scheduled-defaults.js";
import {
  isOneTimeTask,
  oneTimeResultState,
  oneTimeTaskRunAt,
  oneTimeTaskStatus,
  schedulerNotificationId,
  shouldNotify,
  taskSignature,
  type OneTimeTask,
  type RecurringTask,
  type SchedulerJob,
} from "./scheduler-logic.js";

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
  provider: z.enum(["codex", "anthropic", "openrouter"]).optional(),
  model: z.string().min(1).optional(),
});

function validateModelRoute(task: { provider?: string; model?: string }, ctx: z.RefinementCtx): void {
  if ((task.provider === undefined) !== (task.model === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provider and model must be configured together",
      path: task.provider === undefined ? ["provider"] : ["model"],
    });
  }
}

const RecurringTaskSchema = BaseTaskSchema.extend({
  schedule: z.string().min(1),
})
  .strict()
  .superRefine(validateModelRoute);

const OneTimeTaskSchema = BaseTaskSchema.extend({
  run_at: z
    .string()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "run_at must be a valid date/time string",
    }),
  status: z.enum(["pending", "running", "retry_wait", "completed", "failed"]).optional(),
  attempts: z.number().int().nonnegative().optional(),
  max_attempts: z.number().int().min(1).max(10).optional(),
  execution_id: z.string().min(1).optional(),
  next_attempt_at: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .optional(),
  last_attempt_at: z.string().optional(),
  completed_at: z.string().optional(),
  last_error: z.string().optional(),
  notification_id: z.string().min(1).optional(),
  notification_title: z.string().min(1).optional(),
  notification_body: z.string().min(1).optional(),
  notification_enqueued_at: z.string().optional(),
})
  .strict()
  .superRefine(validateModelRoute);

const DynamicTaskSchema = z.union([RecurringTaskSchema, OneTimeTaskSchema]);
const DynamicTasksFileSchema = z.object({ tasks: z.array(DynamicTaskSchema) }).strict();

const TASK_RELOAD_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_ONE_TIME_MAX_ATTEMPTS = 4;
const activeJobs = new Map<string, ActiveScheduledJob>();
const runningTaskIds = new Set<string>();
let lastGoodDynamicTasks: DynamicTask[] = [];
let stopping = false;

type DynamicTask = z.infer<typeof DynamicTaskSchema>;

interface SchedulerNotificationIntent {
  id: string;
  title: string;
  body: string;
}

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
    await atomicWriteFile(
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
    );
  }
  return path;
}

async function schedulerLog(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  log.info(message);
  try {
    await mkdir(paths.scheduledJobs, { recursive: true });
    await appendFileDurable(paths.scheduledJobsLog, line);
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
    await atomicWriteJson(paths.scheduledJobTasks, { tasks: [] });
  }
}

async function readDynamicTasksFile(): Promise<z.infer<typeof DynamicTasksFileSchema>> {
  await ensureTasksFile();
  const raw = await readFile(paths.scheduledJobTasks, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in scheduled tasks file at ${paths.scheduledJobTasks}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = DynamicTasksFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid scheduled tasks file at ${paths.scheduledJobTasks}: ${parsed.error}`);
  return parsed.data;
}

async function loadDynamicTasks(): Promise<DynamicTask[]> {
  try {
    lastGoodDynamicTasks = (await readDynamicTasksFile()).tasks;
    return lastGoodDynamicTasks;
  } catch (err) {
    // Dynamic operator state must never prevent Telegram from coming online.
    await schedulerLog(
      `dynamic tasks ignored until file is repaired: ${err instanceof Error ? err.message : String(err)}`,
    );
    return lastGoodDynamicTasks;
  }
}

async function mutateOneTimeTask(
  id: string,
  mutate: (task: OneTimeTask) => OneTimeTask | undefined,
): Promise<OneTimeTask | undefined> {
  return withFileLock(paths.scheduledJobTasks, async () => {
    const file = await readDynamicTasksFile();
    let result: OneTimeTask | undefined;
    let changed = false;
    const tasks = file.tasks.map((candidate) => {
      if (candidate.id !== id || !("run_at" in candidate)) return candidate;
      const updated = mutate(candidate);
      if (!updated) return candidate;
      changed = true;
      result = updated;
      return updated;
    });
    if (changed) await atomicWriteJson(paths.scheduledJobTasks, { tasks });
    return result;
  });
}

async function recoverInterruptedOneTimeTasks(): Promise<void> {
  let snapshots: OneTimeTask[];
  try {
    snapshots = (await readDynamicTasksFile()).tasks.filter(
      (task): task is OneTimeTask => "run_at" in task && oneTimeTaskStatus(task) === "running",
    );
  } catch (err) {
    await schedulerLog(`one-time recovery skipped: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const snapshot of snapshots) {
    let failed: OneTimeTask | undefined;
    const failure =
      "Task failed: JARVIS stopped during this execution; outcome is unknown, so it was not replayed automatically.";
    const started = snapshot.last_attempt_at ? Date.parse(snapshot.last_attempt_at) : Date.now();
    const notification = schedulerNotificationIntent(
      snapshot,
      false,
      failure,
      Number.isFinite(started) ? started : Date.now(),
    );
    try {
      await withFileLock(
        schedulerExecutionLock(snapshot.id),
        async () => {
          failed = await mutateOneTimeTask(snapshot.id, (current) => {
            if (oneTimeTaskStatus(current) !== "running" || current.execution_id !== snapshot.execution_id) {
              return undefined;
            }
            return {
              ...current,
              status: "failed",
              completed_at: new Date().toISOString(),
              last_error: failure.slice("Task failed: ".length),
              notification_id: notification?.id,
              notification_title: notification?.title,
              notification_body: notification?.body,
              notification_enqueued_at: undefined,
            };
          });
        },
        { timeoutMs: 150, staleMs: 0 },
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("timed out waiting for state lock:")) {
        await schedulerLog(`[${snapshot.id}] running execution is owned by another JARVIS process`);
        continue;
      }
      await schedulerLog(
        `[${snapshot.id}] interrupted execution recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (failed) {
      await schedulerLog(`[${failed.id}] interrupted one-time execution marked failed without replay`);
      await reconcileOneTimeNotification(failed).catch((err) =>
        schedulerLog(
          `[${failed!.id}] notification reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
}

async function loadTasks(): Promise<SchedulerJob[]> {
  const byId = new Map<string, SchedulerJob>();
  for (const task of builtInScheduledTasks) byId.set(task.id, task);
  for (const task of config.scheduler.tasks) byId.set(task.id, task);
  for (const task of await loadDynamicTasks()) byId.set(task.id, task);
  return [...byId.values()];
}

async function claimOneTimeTask(task: OneTimeTask): Promise<OneTimeTask | undefined> {
  return mutateOneTimeTask(task.id, (current) => {
    const status = oneTimeTaskStatus(current);
    if (status !== "pending" && status !== "retry_wait") return undefined;
    // A prior attempt's notification intent is part of its durable result.
    // Do not overwrite it until the deterministic outbox has acknowledged it.
    if (current.notification_id && !current.notification_enqueued_at) return undefined;
    if (oneTimeTaskRunAt(current) > Date.now()) return undefined;
    const timestamp = new Date().toISOString();
    return {
      ...current,
      status: "running",
      attempts: (current.attempts ?? 0) + 1,
      max_attempts: current.max_attempts ?? DEFAULT_ONE_TIME_MAX_ATTEMPTS,
      execution_id: current.execution_id ?? `${current.id}:${Date.parse(current.run_at)}`,
      last_attempt_at: timestamp,
      next_attempt_at: undefined,
      last_error: undefined,
      notification_id: undefined,
      notification_title: undefined,
      notification_body: undefined,
      notification_enqueued_at: undefined,
    };
  });
}

async function recordOneTimeResult(
  task: OneTimeTask,
  success: boolean,
  error?: string,
  retryAllowed = false,
  notification?: SchedulerNotificationIntent,
): Promise<OneTimeTask | undefined> {
  return mutateOneTimeTask(task.id, (current) => {
    if (oneTimeTaskStatus(current) !== "running" || current.execution_id !== task.execution_id) return undefined;
    return oneTimeResultState(current, success, error, retryAllowed, Date.now(), notification);
  });
}

function schedulerNotificationIntent(
  task: SchedulerJob,
  success: boolean,
  output: string,
  started: number,
): SchedulerNotificationIntent | undefined {
  if (!shouldNotify(task, success, output)) return;
  const durationSec = Math.round((Date.now() - started) / 1000);
  const header = success ? `[Scheduler] ${task.name}` : `[Scheduler] ${task.name} — FAILED`;
  const message = `${header}\n\n${output}\n\n(${durationSec}s)`;
  return {
    id: isOneTimeTask(task) ? schedulerNotificationId(task) : "",
    title: task.name,
    body: message,
  };
}

async function reconcileOneTimeNotification(task: OneTimeTask): Promise<OneTimeTask> {
  if (!task.notification_id || !task.notification_title || !task.notification_body || task.notification_enqueued_at) {
    return task;
  }

  await notifyMainOrFallback({
    id: task.notification_id,
    source: "scheduler",
    chat_id: config.scheduler.telegram_chat_id,
    title: task.notification_title,
    body: task.notification_body,
    prompt: task.notification_body,
    fallback_text: task.notification_body,
  });
  const acknowledged = await mutateOneTimeTask(task.id, (current) => {
    if (
      current.notification_id !== task.notification_id ||
      current.notification_title !== task.notification_title ||
      current.notification_body !== task.notification_body
    ) {
      return undefined;
    }
    if (current.notification_enqueued_at) return current;
    return { ...current, notification_enqueued_at: new Date().toISOString() };
  });
  await schedulerLog(`[${task.id}] notification queued`);
  return acknowledged ?? task;
}

async function notifyTaskResult(task: RecurringTask, success: boolean, output: string, started: number): Promise<void> {
  const notification = schedulerNotificationIntent(task, success, output, started);
  if (!notification) return;
  try {
    await notifyMainOrFallback({
      source: "scheduler",
      chat_id: config.scheduler.telegram_chat_id,
      title: notification.title,
      body: notification.body,
      prompt: notification.body,
      fallback_text: notification.body,
    });
    await schedulerLog(`[${task.id}] notification queued`);
  } catch (err) {
    await schedulerLog(`[${task.id}] notification queue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function schedulerExecutionLock(taskId: string): string {
  return join(paths.scheduledJobs, "execution-locks", taskId);
}

async function runTask(inputTask: SchedulerJob): Promise<void> {
  try {
    await withFileLock(schedulerExecutionLock(inputTask.id), () => runTaskLocked(inputTask), {
      timeoutMs: 150,
      staleMs: 0,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("timed out waiting for state lock:")) {
      await schedulerLog(`[${inputTask.id}] skipped: execution is owned by another JARVIS process`);
      return;
    }
    throw err;
  }
}

async function runTaskLocked(inputTask: SchedulerJob): Promise<void> {
  if (runningTaskIds.has(inputTask.id)) return;
  let task = inputTask;
  if (isOneTimeTask(task)) {
    const claimed = await claimOneTimeTask(task);
    if (!claimed) return;
    task = claimed;
  }

  runningTaskIds.add(task.id);
  try {
    const started = Date.now();
    let success = true;
    let retryAllowed = false;
    let output = "";

    await schedulerLog(`[${task.id}] starting: ${task.name}`);
    try {
      const notePath = await ensureTaskNote(task);
      const prompt = isOneTimeTask(task)
        ? [
            `Execution ID: ${task.execution_id}. This ID is stable across retries. Consult the task note and do not repeat a side effect already recorded as complete.`,
            "",
            task.prompt,
          ].join("\n")
        : task.prompt;
      output = await runScheduledPrompt(task.id, task.name, prompt, notePath, {
        provider: task.provider,
        model: task.model,
      });
      await schedulerLog(`[${task.id}] completed (${output.length} chars)`);
    } catch (err) {
      if (stopping || isAgentRunAbortError(err)) {
        success = false;
        output = `Task interrupted: ${err instanceof Error ? err.message : String(err)}`;
        await schedulerLog(`[${task.id}] cancelled during shutdown`);
      } else {
        success = false;
        retryAllowed = err instanceof AgentExecutionError && err.replaySafe && err.failureClass === "transient";
        output = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
        await schedulerLog(`[${task.id}] failed: ${output}`);
      }
    }

    let persistedOneTime: OneTimeTask | undefined;
    if (isOneTimeTask(task)) {
      // Commit the execution result and notification intent together. A crash
      // at any later point is repaired by deterministic outbox reconciliation.
      const notification = schedulerNotificationIntent(task, success, output, started);
      persistedOneTime = await recordOneTimeResult(
        task,
        success,
        success ? undefined : output,
        retryAllowed,
        notification,
      );
      if (!persistedOneTime) {
        await schedulerLog(`[${task.id}] execution result not persisted because task state changed concurrently`);
      } else if (persistedOneTime.status === "retry_wait") {
        await schedulerLog(
          `[${task.id}] retry ${persistedOneTime.attempts}/${persistedOneTime.max_attempts} scheduled for ${persistedOneTime.next_attempt_at}`,
        );
      } else {
        await schedulerLog(`[${task.id}] retained with terminal state ${persistedOneTime.status}`);
      }
    }

    if (!stopping && persistedOneTime) {
      persistedOneTime = await reconcileOneTimeNotification(persistedOneTime).catch(async (err) => {
        await schedulerLog(
          `[${task.id}] notification reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return persistedOneTime;
      });
    } else if (!stopping && !isOneTimeTask(task)) {
      await notifyTaskResult(task, success, output, started);
    }
    if (!stopping && persistedOneTime?.status === "retry_wait") await registerOneTimeTask(persistedOneTime);
  } finally {
    runningTaskIds.delete(task.id);
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

  const cronJob = cron.schedule(task.schedule, () => runTask(task), {
    timezone: config.scheduler.timezone,
    name: task.id,
    noOverlap: true,
  });
  activeJobs.set(task.id, { cronJob, signature });
  await schedulerLog(`[${task.id}] registered: ${task.name} @ ${task.schedule}`);
}

async function registerOneTimeTask(task: OneTimeTask): Promise<void> {
  await ensureTaskNote(task);
  const status = oneTimeTaskStatus(task);
  if (status === "completed" || status === "failed" || status === "running") {
    stopTask(task.id);
    return;
  }
  const runAt = oneTimeTaskRunAt(task);
  if (Number.isNaN(runAt)) {
    await schedulerLog(`[${task.id}] invalid run time: ${task.next_attempt_at ?? task.run_at}`);
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
      activeJobs.delete(task.id);
      void runTask(task).catch((err) =>
        schedulerLog(`[${task.id}] one-time run failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
    Math.max(0, Math.min(delay, MAX_TIMEOUT_MS)),
  );
  activeJobs.set(task.id, { timeout, signature });

  const when = delay <= 0 ? "now" : new Date(runAt).toISOString();
  await schedulerLog(`[${task.id}] registered one-time (${status}): ${task.name} @ ${when}`);
}

async function registerTask(task: SchedulerJob): Promise<void> {
  if (isOneTimeTask(task)) await registerOneTimeTask(task);
  else await registerRecurringTask(task);
}

async function reloadTasks(): Promise<void> {
  await recoverInterruptedOneTimeTasks();
  const tasks = await loadTasks();
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    if (!isOneTimeTask(task) || !task.notification_id || task.notification_enqueued_at) continue;
    tasks[index] = await reconcileOneTimeNotification(task).catch(async (err) => {
      await schedulerLog(
        `[${task.id}] notification reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return task;
    });
  }
  const seen = new Set(tasks.map((task) => task.id));

  for (const id of [...activeJobs.keys()]) {
    if (!seen.has(id)) {
      stopTask(id);
      await schedulerLog(`[${id}] unregistered`);
    }
  }
  for (const task of tasks) await registerTask(task);
}

export async function startScheduler(): Promise<() => void> {
  if (!config.scheduler.enabled) {
    log.info("scheduler disabled");
    return () => {};
  }

  stopping = false;
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
    stopping = true;
    clearInterval(reloadTimer);
    for (const id of [...activeJobs.keys()]) stopTask(id);
  };
}
