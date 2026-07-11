import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import cron from "node-cron";
import { z } from "zod";
import { config } from "./config.js";
import { atomicWriteJson, withFileLock } from "./lib/durable-file.js";
import { log } from "./lib/logger.js";
import { paths } from "./paths.js";
import { builtInScheduledTasks } from "./scheduled-defaults.js";
import type { DynamicTask, OneTimeTask, RecurringTask } from "./scheduler-logic.js";

const NotifySchema = z.enum(["always", "on_issue", "never"]);
const ProviderSchema = z.enum(["codex", "anthropic", "openrouter"]);
const MetadataSchema = {
  timezone: z.string().min(1).optional(),
  revision: z.number().int().positive().optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  request_fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  last_mutation_key: z.string().min(1).max(200).optional(),
};
const BaseTaskSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(20_000),
  notify: NotifySchema,
  provider: ProviderSchema.optional(),
  model: z.string().min(1).optional(),
  ...MetadataSchema,
});
function validateRoute(task: { provider?: string; model?: string }, ctx: z.RefinementCtx): void {
  if ((task.provider === undefined) !== (task.model === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provider and model must be configured together" });
  }
}
function validateTimezone(task: { timezone?: string }, ctx: z.RefinementCtx): void {
  if (!task.timezone) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: task.timezone }).format();
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timezone"], message: "invalid IANA timezone" });
  }
}
export const RecurringTaskSchema = BaseTaskSchema.extend({
  schedule: z.string().min(1),
  status: z.enum(["active", "cancelled"]).optional(),
})
  .strict()
  .superRefine((task, ctx) => {
    validateRoute(task, ctx);
    validateTimezone(task, ctx);
    if (!cron.validate(task.schedule))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule"], message: "invalid cron expression" });
  });
export const OneTimeTaskSchema = BaseTaskSchema.extend({
  run_at: z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid run_at"),
  status: z.enum(["pending", "running", "retry_wait", "completed", "failed", "cancelled"]).optional(),
  attempts: z.number().int().nonnegative().optional(),
  max_attempts: z.number().int().min(1).max(10).optional(),
  execution_id: z.string().min(1).optional(),
  next_attempt_at: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
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
  .superRefine((task, ctx) => {
    validateRoute(task, ctx);
    validateTimezone(task, ctx);
  });
export const DynamicTaskSchema = z.union([RecurringTaskSchema, OneTimeTaskSchema]);
export const DynamicTasksFileSchema = z.object({ tasks: z.array(DynamicTaskSchema) }).strict();

let reconcile: (() => Promise<void>) | undefined;
export function setSchedulerReconciler(fn: (() => Promise<void>) | undefined): void {
  reconcile = fn;
}
async function reconcileNow(): Promise<void> {
  if (!reconcile) return;
  try {
    await reconcile();
  } catch (error) {
    // The durable mutation already committed. Do not report it as failed and
    // invite a duplicate side effect; the scheduler's periodic reload repairs
    // registration, while this warning makes the delay observable.
    log.warn("immediate scheduler reconciliation failed; periodic reload will retry", {
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ensureFile(): Promise<void> {
  await mkdir(paths.scheduledJobs, { recursive: true });
  try {
    await readFile(paths.scheduledJobTasks, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWriteJson(paths.scheduledJobTasks, { tasks: [] });
  }
}
export async function readDynamicTaskFile(): Promise<{ tasks: DynamicTask[] }> {
  await ensureFile();
  const raw = await readFile(paths.scheduledJobTasks, "utf-8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid scheduled tasks JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = DynamicTasksFileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid scheduled tasks file: ${parsed.error}`);
  return parsed.data;
}

const weekdays: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};
function localParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const values: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(date))
    values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdays[values.weekday.toLowerCase()],
  };
}
function zonedInstant(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsets = new Set<number>();
  for (const delta of [-7, -1, 0, 1, 7]) {
    const probe = new Date(naive + delta * 86_400_000);
    const local = localParts(probe, timezone);
    offsets.add(
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) -
        probe.getTime() +
        probe.getUTCSeconds() * 1000 +
        probe.getUTCMilliseconds(),
    );
  }
  const matches = [...offsets]
    .map((offset) => new Date(naive - offset))
    .filter((candidate) => {
      const local = localParts(candidate, timezone);
      return (
        local.year === parts.year &&
        local.month === parts.month &&
        local.day === parts.day &&
        local.hour === parts.hour &&
        local.minute === parts.minute
      );
    });
  const unique = [...new Map(matches.map((date) => [date.toISOString(), date])).values()];
  if (unique.length === 0) throw new Error("That local time does not exist because of a daylight-saving transition");
  if (unique.length > 1)
    throw new Error(
      "That local time is ambiguous because of a daylight-saving transition; use an ISO timestamp with an offset",
    );
  return unique[0];
}
function parseClock(value: string): { hour: number; minute: number } {
  const match = value.match(/^([01]?\d|2[0-3])(?::([0-5]\d))?$/);
  if (!match) throw new Error("Time must use 24-hour HH[:MM] format");
  return { hour: Number(match[1]), minute: Number(match[2] ?? 0) };
}
export function parseNaturalRunAt(input: string, timezone = config.scheduler.timezone, now = new Date()): string {
  const text = input.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}t/.test(text)) {
    if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(text))
      throw new Error("ISO timestamps must include Z or an explicit UTC offset");
    const instant = new Date(text);
    if (!Number.isFinite(instant.getTime())) throw new Error("Invalid ISO timestamp");
    return instant.toISOString();
  }
  const relative = text.match(/^in ([1-9]\d{0,5}) (minute|minutes|hour|hours|day|days)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].startsWith("minute") ? 60_000 : relative[2].startsWith("hour") ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + amount * unit).toISOString();
  }
  const current = localParts(now, timezone);
  const tomorrow = text.match(/^tomorrow at (\d{1,2}(?::\d{2})?)$/);
  if (tomorrow) {
    const clock = parseClock(tomorrow[1]);
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    return zonedInstant(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...clock },
      timezone,
    ).toISOString();
  }
  const weekday = text.match(
    /^(?:(?:next )?)(sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (\d{1,2}(?::\d{2})?)$/,
  );
  if (weekday) {
    const desired = weekdays[weekday[1]];
    let delta = (desired - current.weekday + 7) % 7;
    if (delta === 0 || text.startsWith("next ")) delta = delta || 7;
    const clock = parseClock(weekday[2]);
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + delta));
    return zonedInstant(
      { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...clock },
      timezone,
    ).toISOString();
  }
  throw new Error(
    "Unsupported or ambiguous time. Use ISO with offset, 'in N minutes/hours/days', 'tomorrow at HH[:MM]', or '[next] weekday at HH[:MM]'.",
  );
}

export function parseRecurringSchedule(input: string): string {
  const text = input.trim().toLowerCase();
  if (cron.validate(text)) return text;
  let match = text.match(/^daily at (\d{1,2}(?::\d{2})?)$/);
  if (match) {
    const time = parseClock(match[1]);
    return `${time.minute} ${time.hour} * * *`;
  }
  match = text.match(/^every weekday at (\d{1,2}(?::\d{2})?)$/);
  if (match) {
    const time = parseClock(match[1]);
    return `${time.minute} ${time.hour} * * 1-5`;
  }
  match = text.match(/^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (\d{1,2}(?::\d{2})?)$/);
  if (match) {
    const time = parseClock(match[2]);
    return `${time.minute} ${time.hour} * * ${weekdays[match[1]]}`;
  }
  match = text.match(/^every ([1-9]\d?) minutes$/);
  if (match && Number(match[1]) <= 59) return `*/${Number(match[1])} * * * *`;
  match = text.match(/^every ([1-9]|1\d|2[0-3]) hours?$/);
  if (match) return `0 */${Number(match[1])} * * *`;
  if (text === "hourly") return "0 * * * *";
  throw new Error(
    "Unsupported recurrence. Use validated cron, daily/weekday/weekday-name at HH[:MM], hourly, or every N minutes/hours.",
  );
}

function reservedIds(): Set<string> {
  return new Set([...builtInScheduledTasks, ...config.scheduler.tasks].map((task) => task.id));
}
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "task"
  );
}
function makeId(name: string, key?: string): string {
  const suffix = createHash("sha256")
    .update(key ?? randomUUID())
    .digest("hex")
    .slice(0, 8);
  return `${slug(name)}-${suffix}`;
}
export interface CreateTaskInput {
  id?: string;
  name: string;
  prompt: string;
  when?: string;
  recurrence?: string;
  timezone?: string;
  notify?: "always" | "on_issue" | "never";
  idempotencyKey?: string;
}
export async function createDynamicTask(input: CreateTaskInput): Promise<{ task: DynamicTask; created: boolean }> {
  const timezone = input.timezone ?? config.scheduler.timezone;
  if (Boolean(input.when) === Boolean(input.recurrence)) throw new Error("Specify exactly one of when or recurrence");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        id: input.id,
        name: input.name,
        prompt: input.prompt,
        when: input.when,
        recurrence: input.recurrence,
        timezone,
        notify: input.notify ?? "always",
      }),
    )
    .digest("hex");
  const result = await withFileLock(paths.scheduledJobTasks, async () => {
    const file = await readDynamicTaskFile();
    if (input.idempotencyKey) {
      const existing = file.tasks.find((task) => task.idempotency_key === input.idempotencyKey);
      if (existing) {
        if (existing.request_fingerprint && existing.request_fingerprint !== fingerprint)
          throw new Error("Idempotency key was already used for a different task request");
        return { task: existing, created: false };
      }
    }
    const id = input.id ?? makeId(input.name, input.idempotencyKey);
    if (reservedIds().has(id)) throw new Error(`Task id '${id}' is reserved by a built-in or configured task`);
    if (file.tasks.some((task) => task.id === id)) throw new Error(`Dynamic task id '${id}' already exists`);
    const base = {
      id,
      name: input.name,
      prompt: input.prompt,
      notify: input.notify ?? "always",
      timezone,
      revision: 1,
      idempotency_key: input.idempotencyKey,
      request_fingerprint: input.idempotencyKey ? fingerprint : undefined,
    };
    const task = input.when
      ? OneTimeTaskSchema.parse({ ...base, run_at: parseNaturalRunAt(input.when, timezone) })
      : RecurringTaskSchema.parse({ ...base, schedule: parseRecurringSchedule(input.recurrence!), status: "active" });
    await atomicWriteJson(paths.scheduledJobTasks, { tasks: [...file.tasks, task] });
    return { task, created: true };
  });
  if (result.created) await reconcileNow();
  return result;
}

export interface UpdateTaskInput {
  id: string;
  expectedRevision?: number;
  mutationKey?: string;
  name?: string;
  prompt?: string;
  when?: string;
  recurrence?: string;
  timezone?: string;
  notify?: "always" | "on_issue" | "never";
}
async function mutateTask(
  id: string,
  expectedRevision: number | undefined,
  mutationKey: string | undefined,
  mutate: (task: DynamicTask) => DynamicTask,
): Promise<DynamicTask> {
  const result = await withFileLock(paths.scheduledJobTasks, async () => {
    const file = await readDynamicTaskFile();
    const index = file.tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error(`Dynamic task '${id}' not found`);
    const current = file.tasks[index];
    if (mutationKey && current.last_mutation_key === mutationKey) return { task: current, changed: false };
    const revision = current.revision ?? 1;
    if (expectedRevision !== undefined && revision !== expectedRevision)
      throw new Error(`Revision conflict: expected ${expectedRevision}, current ${revision}`);
    const next = DynamicTaskSchema.parse({
      ...mutate(current),
      revision: revision + 1,
      last_mutation_key: mutationKey,
    });
    const tasks = file.tasks.slice();
    tasks[index] = next;
    await atomicWriteJson(paths.scheduledJobTasks, { tasks });
    return { task: next, changed: true };
  });
  if (result.changed) await reconcileNow();
  return result.task;
}
function assertMutable(task: DynamicTask): void {
  if ("run_at" in task && ["running", "completed", "failed", "cancelled"].includes(task.status ?? "pending"))
    throw new Error(`One-time task is ${task.status}; it cannot be changed`);
  if ("schedule" in task && task.status === "cancelled")
    throw new Error("Recurring task is cancelled; it cannot be changed");
}
export async function updateDynamicTask(input: UpdateTaskInput): Promise<DynamicTask> {
  return mutateTask(input.id, input.expectedRevision, input.mutationKey, (current) => {
    assertMutable(current);
    const timezone = input.timezone ?? current.timezone ?? config.scheduler.timezone;
    const common = {
      ...current,
      name: input.name ?? current.name,
      prompt: input.prompt ?? current.prompt,
      notify: input.notify ?? current.notify,
      timezone,
    };
    if ("run_at" in current) {
      if (input.recurrence) throw new Error("Cannot convert a one-time task to recurring");
      return {
        ...common,
        run_at: input.when ? parseNaturalRunAt(input.when, timezone) : current.run_at,
        next_attempt_at: undefined,
        execution_id: undefined,
      } as OneTimeTask;
    }
    if (input.when) throw new Error("Cannot convert a recurring task to one-time");
    return {
      ...common,
      schedule: input.recurrence ? parseRecurringSchedule(input.recurrence) : current.schedule,
    } as RecurringTask;
  });
}
export async function snoozeDynamicTask(
  id: string,
  when: string,
  expectedRevision?: number,
  mutationKey?: string,
): Promise<DynamicTask> {
  return mutateTask(id, expectedRevision, mutationKey, (current) => {
    if (!("run_at" in current)) throw new Error("Only one-time tasks can be snoozed");
    assertMutable(current);
    const timezone = current.timezone ?? config.scheduler.timezone;
    return {
      ...current,
      run_at: parseNaturalRunAt(when, timezone),
      next_attempt_at: undefined,
      execution_id: undefined,
      status: "pending",
      attempts: 0,
    };
  });
}
export async function cancelDynamicTask(
  id: string,
  expectedRevision?: number,
  mutationKey?: string,
): Promise<DynamicTask> {
  return mutateTask(id, expectedRevision, mutationKey, (current) => {
    if ("run_at" in current && current.status === "running")
      throw new Error("A running task cannot be cancelled because its side-effect outcome would be unknown");
    if ("run_at" in current && ["completed", "failed"].includes(current.status ?? "pending"))
      throw new Error(`Terminal task is ${current.status}; it cannot be cancelled`);
    return { ...current, status: "cancelled", next_attempt_at: undefined } as DynamicTask;
  });
}
export async function listDynamicTasks(options: { includeTerminal?: boolean } = {}): Promise<DynamicTask[]> {
  const tasks = (await readDynamicTaskFile()).tasks;
  if (options.includeTerminal) return tasks;
  return tasks.filter((task) =>
    "schedule" in task
      ? task.status !== "cancelled"
      : !["completed", "failed", "cancelled"].includes(task.status ?? "pending"),
  );
}
