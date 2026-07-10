import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { paths } from "../paths.js";
import { log } from "../lib/logger.js";
import { readProcessStartTime } from "../lib/process-identity.js";
import { config } from "../config.js";
import { appendFileDurable, atomicWriteFile, atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { appendJsonLinesDurable, readJsonLinesRecovering } from "../lib/json-lines.js";
import type { BackgroundMailEntry, BackgroundRole, BackgroundStage, BackgroundTask } from "./types.js";
import { choosePipeline, friendlyIdFromUuid, nextQueuedRole } from "./logic.js";
import { backgroundLifecycleNotificationId } from "./worker-logic.js";

export interface StartBackgroundTaskOptions {
  goalId?: string;
  pipeline?: BackgroundStage[];
  /** Create durable queued state without spawning; used for transactional goal linkage. */
  deferStart?: boolean;
}

export { choosePipeline, friendlyIdFromUuid, nextQueuedRole, renderTask, renderTaskList } from "./logic.js";

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = paths.repo;
const workerCapacityLock = join(paths.backgroundTasks, ".worker-capacity");
const taskCreationLock = join(paths.backgroundTasks, ".task-creation");
const TERMINAL_STATUSES = new Set<BackgroundTask["status"]>([
  "needs_fix",
  "ready_for_pr",
  "failed",
  "cancelled",
  "done",
]);
const BACKGROUND_ID_PATTERN = /^(?:[a-z]+-[a-z]+|task-[0-9a-f]{8})$/;

function now(): string {
  return new Date().toISOString();
}

async function createTaskIdentity(): Promise<{ id: string; uuid: string }> {
  for (let i = 0; i < 20; i += 1) {
    const uuid = randomUUID();
    const id = friendlyIdFromUuid(uuid);
    if (!(await pathExists(taskPath(id)))) return { id, uuid };
  }

  const uuid = randomUUID();
  return { id: `task-${uuid.slice(0, 8)}`, uuid };
}

function taskPath(id: string): string {
  assertBackgroundId(id);
  return join(paths.backgroundTasks, `${id}.json`);
}

function mailPath(id: string): string {
  assertBackgroundId(id);
  return join(paths.backgroundMail, `${id}.jsonl`);
}

function assertBackgroundId(id: string): void {
  if (!BACKGROUND_ID_PATTERN.test(id)) throw new Error(`invalid background task id: ${id}`);
}

function normalizeTask(task: BackgroundTask): BackgroundTask {
  assertBackgroundId(task.id);
  task.uuid = task.uuid ?? `legacy-${task.id}`;
  task.pipeline = task.pipeline ?? [
    { role: "implementer", status: task.status === "awaiting_review" ? "done" : "queued" },
    { role: "reviewer", status: "queued" },
  ];
  task.revision = task.revision ?? 0;
  if (!Number.isSafeInteger(task.revision) || task.revision < 0) {
    throw new Error(`invalid background task revision for ${task.id}`);
  }
  return task;
}

async function readBackgroundTaskUnlocked(id: string): Promise<BackgroundTask> {
  const task = normalizeTask(JSON.parse(await readFile(taskPath(id), "utf-8")) as BackgroundTask);
  if (task.id !== id) throw new Error(`background task file ${id} contains state for ${task.id}`);
  return task;
}

export async function readBackgroundTask(id: string): Promise<BackgroundTask> {
  return readBackgroundTaskUnlocked(id);
}

async function writeBackgroundTaskUnlocked(task: BackgroundTask, current?: BackgroundTask): Promise<void> {
  await mkdir(paths.backgroundTasks, { recursive: true });
  let stored = current;
  if (!stored) {
    try {
      stored = await readBackgroundTaskUnlocked(task.id);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  if (stored && stored.uuid !== task.uuid) throw new Error(`background task id collision: ${task.id}`);
  const expectedRevision = task.revision ?? 0;
  const storedRevision = stored?.revision ?? 0;
  if (stored && expectedRevision !== storedRevision) {
    throw new Error(
      `background task ${task.id} changed concurrently (expected revision ${expectedRevision}, found ${storedRevision})`,
    );
  }
  const persisted: BackgroundTask = {
    ...task,
    launch_deferred: TERMINAL_STATUSES.has(task.status) ? undefined : task.launch_deferred,
    preparing: TERMINAL_STATUSES.has(task.status) ? undefined : task.preparing,
    preparing_pid: TERMINAL_STATUSES.has(task.status) ? undefined : task.preparing_pid,
    preparing_pid_start_time: TERMINAL_STATUSES.has(task.status) ? undefined : task.preparing_pid_start_time,
    preparing_started_at: TERMINAL_STATUSES.has(task.status) ? undefined : task.preparing_started_at,
    pid: TERMINAL_STATUSES.has(task.status) ? undefined : task.pid,
    updated_at: now(),
    revision: storedRevision + 1,
  };
  await atomicWriteJson(taskPath(task.id), persisted);
  Object.assign(task, persisted);
}

export async function writeBackgroundTask(task: BackgroundTask): Promise<void> {
  await withFileLock(taskPath(task.id), () => writeBackgroundTaskUnlocked(task));
}

export async function appendBackgroundMail(id: string, entry: Omit<BackgroundMailEntry, "ts">): Promise<void> {
  await mkdir(paths.backgroundMail, { recursive: true });
  await appendJsonLinesDurable(mailPath(id), JSON.stringify({ ts: now(), ...entry }) + "\n");
}

export async function readBackgroundMail(id: string, limit = 20): Promise<BackgroundMailEntry[]> {
  return (await readJsonLinesRecovering<BackgroundMailEntry>(mailPath(id))).slice(-limit);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createWorktree(task: BackgroundTask): Promise<void> {
  await mkdir(paths.backgroundWorktrees, { recursive: true });
  if (await pathExists(task.worktree)) {
    throw new Error(`worktree already exists: ${task.worktree}`);
  }
  await execFileAsync("git", ["-C", task.repo, "worktree", "add", "-b", task.branch, task.worktree, "HEAD"], {
    timeout: 60_000,
  });
}

export async function listBackgroundTasks(): Promise<BackgroundTask[]> {
  await mkdir(paths.backgroundTasks, { recursive: true });
  const files = (await readdir(paths.backgroundTasks))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => join(paths.backgroundTasks, file));
  const tasks = (
    await Promise.all(
      files.map(async (file) => {
        try {
          return normalizeTask(JSON.parse(await readFile(file, "utf-8")) as BackgroundTask);
        } catch (err) {
          log.warn("skipping unreadable background task state", {
            file,
            err: err instanceof Error ? err.message : String(err),
          });
          return undefined;
        }
      }),
    )
  ).filter((task): task is BackgroundTask => task !== undefined);
  return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

interface SpawnAcknowledgementChild {
  pid?: number;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

export function waitForSpawnAcknowledgement(child: SpawnAcknowledgementChild): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      if (!child.pid || child.pid <= 0) {
        reject(new Error("background worker spawned without a valid pid"));
        return;
      }
      child.unref();
      resolve(child.pid);
    });
  });
}

export async function spawnBackgroundWorker(id: string, role?: BackgroundRole): Promise<number> {
  assertBackgroundId(id);
  const sourceRoot = process.env.JARVIS_SOURCE_ROOT ?? process.cwd();
  const workerScript = join(sourceRoot, "dist", "background", "worker.js");
  const launcher = join(sourceRoot, "scripts", "run-background-worker.sh");
  const args = role ? [id, workerScript, role] : [id, workerScript];
  const child = spawn(launcher, args, {
    cwd: sourceRoot,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      JARVIS_SOURCE_ROOT: sourceRoot,
    },
  });
  try {
    const pid = await waitForSpawnAcknowledgement(child);
    log.info("background worker spawned", { id, role, pid });
    return pid;
  } catch (err) {
    log.error("background worker spawn failed", { id, role, err: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function liveWorkerTaskCount(excludeTaskId: string): Promise<number> {
  await mkdir(paths.backgroundTasks, { recursive: true });
  const files = (await readdir(paths.backgroundTasks)).filter((file) => file.endsWith(".json"));
  let count = 0;
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    if (id === excludeTaskId) continue;
    try {
      const task = await readBackgroundTaskUnlocked(id);
      if (!TERMINAL_STATUSES.has(task.status) && task.pid && (await isOwnedWorkerPid(task.pid, task.id))) count += 1;
    } catch (err) {
      log.warn("unable to inspect background task while enforcing worker capacity", {
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return count;
}

/** Caller must hold the task lock; the capacity lock covers spawn + PID persistence. */
async function spawnAndPersistBackgroundWorker(task: BackgroundTask, role: BackgroundRole): Promise<boolean> {
  return withFileLock(workerCapacityLock, async () => {
    const limit = config.background?.max_concurrent_workers ?? 2;
    const active = await liveWorkerTaskCount(task.id);
    if (active >= limit) {
      log.info("background task queued at worker capacity", { id: task.id, role, active, limit });
      return false;
    }
    const pid = await spawnBackgroundWorker(task.id, role);
    task.pid = pid;
    try {
      await writeBackgroundTaskUnlocked(task, task);
    } catch (err) {
      if (pid > 0) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // The failed persistence must remain the primary error.
        }
      }
      throw err;
    }
    return true;
  });
}

export async function startBackgroundTask(
  prompt: string,
  chatId: number,
  repo = DEFAULT_REPO,
  options: StartBackgroundTaskOptions = {},
): Promise<BackgroundTask> {
  return withFileLock(taskCreationLock, () => createBackgroundTask(prompt, chatId, repo, options), {
    timeoutMs: 5 * 60_000,
  });
}

async function createBackgroundTask(
  prompt: string,
  chatId: number,
  repo: string,
  options: StartBackgroundTaskOptions,
): Promise<BackgroundTask> {
  const { id, uuid } = await createTaskIdentity();
  const branch = `worker/${id}`;
  const worktree = join(paths.backgroundWorktrees, id);
  const pipeline = options.pipeline ?? choosePipeline(prompt);
  const currentRole = nextQueuedRole({ pipeline } as BackgroundTask);
  const preparingPidStartTime = await readProcessStartTime(process.pid);
  const task: BackgroundTask = {
    id,
    uuid,
    name: prompt.split("\n")[0].slice(0, 80),
    status: "queued",
    prompt,
    repo,
    worktree,
    branch,
    chat_id: chatId,
    pipeline,
    goal_id: options.goalId,
    current_role: currentRole,
    launch_deferred: true,
    preparing: true,
    preparing_pid: process.pid,
    preparing_pid_start_time: preparingPidStartTime,
    preparing_started_at: now(),
    created_at: now(),
    updated_at: now(),
  };

  await writeBackgroundTask(task);
  try {
    await mkdir(paths.backgroundNotes, { recursive: true });
    await createWorktree(task);
    await atomicWriteFile(
      join(paths.backgroundNotes, `${id}.md`),
      `# ${task.name}\n\n**Status:** queued\n**Worktree:** ${worktree}\n**Branch:** ${branch}\n**Pipeline:** ${pipeline.map((stage) => stage.role).join(" -> ")}\n\n## Prompt\n${prompt}\n\n## Updates\n- ${now()}: task created.\n`,
    );
    await appendBackgroundMail(id, {
      from: "main",
      type: "status",
      body: `Task created. Pipeline: ${pipeline.map((stage) => stage.role).join(" -> ")}. Worktree prepared.`,
    });
  } catch (err) {
    task.status = "failed";
    task.current_role = undefined;
    task.finished_at = now();
    task.error = `task preparation failed: ${err instanceof Error ? err.message : String(err)}`;
    task.terminal_notification_id = backgroundLifecycleNotificationId(task, "terminal-failed");
    task.terminal_notification_enqueued_at = undefined;
    task.preparing = undefined;
    task.preparing_pid = undefined;
    task.preparing_pid_start_time = undefined;
    task.preparing_started_at = undefined;
    task.launch_deferred = undefined;
    await writeBackgroundTask(task).catch((writeErr) =>
      log.error("failed to persist background preparation failure", {
        id,
        err: writeErr instanceof Error ? writeErr.message : String(writeErr),
      }),
    );
    throw err;
  }

  await withFileLock(taskPath(task.id), async () => {
    task.preparing = undefined;
    task.preparing_pid = undefined;
    task.preparing_pid_start_time = undefined;
    task.preparing_started_at = undefined;
    task.launch_deferred = options.deferStart || undefined;
    await writeBackgroundTaskUnlocked(task);
    if (currentRole && !options.deferStart) {
      await spawnAndPersistBackgroundWorker(task, currentRole);
    }
  });
  return task;
}

export async function launchBackgroundTask(id: string): Promise<BackgroundTask> {
  return withFileLock(taskPath(id), async () => {
    const task = await readBackgroundTaskUnlocked(id);
    if (task.launch_deferred) throw new Error(`${id} is waiting for its goal reservation to be linked`);
    if (task.status !== "queued") throw new Error(`${id} cannot launch from status ${task.status}; expected queued`);
    if (task.pid && (await isOwnedWorkerPid(task.pid, task.id))) {
      throw new Error(`${id} already has a live worker (${task.pid})`);
    }
    task.pid = undefined;
    const role = task.current_role ?? nextQueuedRole(task);
    if (!role) throw new Error(`${id} has no queued role to launch`);
    task.current_role = role;
    await spawnAndPersistBackgroundWorker(task, role);
    return task;
  });
}

/** Make a goal-created task launchable only after its parent link is durable. */
export async function activateDeferredBackgroundTask(id: string): Promise<BackgroundTask> {
  return withFileLock(taskPath(id), async () => {
    const task = await readBackgroundTaskUnlocked(id);
    if (!task.launch_deferred) return task;
    if (task.preparing) throw new Error(`${id} is still preparing its worktree`);
    if (task.status !== "queued") {
      throw new Error(`${id} cannot activate a deferred launch from status ${task.status}`);
    }
    task.launch_deferred = undefined;
    await writeBackgroundTaskUnlocked(task, task);
    return task;
  });
}

export async function answerBackgroundTask(id: string, body: string): Promise<BackgroundTask> {
  return withFileLock(taskPath(id), async () => {
    const task = await readBackgroundTaskUnlocked(id);
    if (task.status !== "waiting_on_main") {
      throw new Error(`${id} cannot accept an answer from status ${task.status}; expected waiting_on_main`);
    }
    if (task.pid && (await isOwnedWorkerPid(task.pid, task.id))) {
      throw new Error(`${id} still has a live worker (${task.pid})`);
    }
    const role = task.current_role ?? nextQueuedRole(task);
    if (!role) throw new Error(`${id} has no role to resume after the answer`);
    const stage = [...task.pipeline].reverse().find((candidate) => candidate.role === role);
    if (stage) {
      stage.status = "queued";
      stage.error = undefined;
      stage.finished_at = undefined;
    }
    await appendBackgroundMail(id, { from: "main", type: "answer", body });
    task.status = "queued";
    task.launch_deferred = undefined;
    task.current_role = role;
    task.finished_at = undefined;
    task.error = undefined;
    task.terminal_notification_id = undefined;
    task.terminal_notification_enqueued_at = undefined;
    task.pid = undefined;
    await writeBackgroundTaskUnlocked(task, task);
    await spawnAndPersistBackgroundWorker(task, role);
    return task;
  });
}

export async function cancelBackgroundTask(id: string): Promise<BackgroundTask> {
  return withFileLock(taskPath(id), async () => {
    const task = await readBackgroundTaskUnlocked(id);
    if (TERMINAL_STATUSES.has(task.status)) {
      // Terminal tasks must never act on a persisted PID: it may have been
      // reused by an unrelated process since the worker exited.
      if (task.pid !== undefined) {
        task.pid = undefined;
        await writeBackgroundTaskUnlocked(task, task);
      }
      return task;
    }
    if (task.pid && (await isOwnedWorkerPid(task.pid, task.id))) {
      try {
        // Detached workers are process-group leaders. Signal the group so a
        // bootstrap shell cannot leave nvm/pnpm/node descendants behind.
        process.kill(-task.pid, "SIGTERM");
      } catch {
        try {
          process.kill(task.pid, "SIGTERM");
        } catch {
          // Already gone. Fine.
        }
      }
    } else if (task.pid) {
      log.warn("refusing to signal unverified background pid", { id, pid: task.pid });
    }
    task.status = "cancelled";
    task.launch_deferred = undefined;
    task.pid = undefined;
    task.current_role = undefined;
    task.finished_at = now();
    for (const stage of task.pipeline) {
      if (stage.status === "queued" || stage.status === "running") {
        stage.status = "skipped";
        stage.finished_at = stage.finished_at ?? now();
      }
    }
    await appendBackgroundMail(id, { from: "main", type: "status", body: "Task cancelled by main JARVIS." });
    await writeBackgroundTaskUnlocked(task, task);
    return task;
  });
}

async function isOwnedWorkerPid(pid: number, taskId: string): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  let commandLine: string;
  try {
    commandLine = await readFile(`/proc/${pid}/cmdline`, "utf-8");
  } catch {
    return false;
  }
  const args = commandLine.split("\0").filter(Boolean);
  const ownsTask = args.includes(taskId);
  const isWorker = args.some(
    (arg) => arg.endsWith("run-background-worker.sh") || /(?:^|\/)background\/worker\.js$/.test(arg),
  );
  return ownsTask && isWorker;
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isTaskRunning(task: BackgroundTask): boolean {
  if (TERMINAL_STATUSES.has(task.status) || task.status === "waiting_on_main") return false;
  return (
    isPidAlive(task.pid) ||
    task.pipeline.some((stage) => stage.status === "running") ||
    ["queued", "running", "researching", "implementing", "reviewing", "awaiting_review"].includes(task.status)
  );
}

async function appendTaskNote(id: string, line: string): Promise<void> {
  await mkdir(paths.backgroundNotes, { recursive: true });
  await appendFileDurable(join(paths.backgroundNotes, `${id}.md`), line);
}

export async function resumeBackgroundTask(id: string, role: "fixer" | "reviewer" = "fixer"): Promise<BackgroundTask> {
  return withFileLock(taskPath(id), async () => {
    const task = await readBackgroundTaskUnlocked(id);
    if (task.pid && (await isOwnedWorkerPid(task.pid, task.id))) {
      throw new Error(`${id} still has a live worker (${task.pid})`);
    }
    task.pid = undefined;
    if (isTaskRunning(task)) throw new Error(`${id} is currently running or queued`);
    if (!["needs_fix", "failed"].includes(task.status)) {
      throw new Error(`${id} cannot be resumed from status ${task.status}; expected needs_fix or failed`);
    }
    if (!task.worktree) throw new Error(`${id} has no worktree recorded`);
    const worktreeStat = await stat(task.worktree).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`${id} worktree does not exist: ${task.worktree}`);
      throw err;
    });
    if (!worktreeStat.isDirectory()) throw new Error(`${id} worktree is not a directory: ${task.worktree}`);

    const stages: BackgroundStage[] =
      role === "fixer"
        ? [
            { role: "fixer", status: "queued" },
            { role: "reviewer", status: "queued" },
          ]
        : [{ role: "reviewer", status: "queued" }];
    task.pipeline.push(...stages);
    if (role === "fixer") task.automatic_fix_attempted = true;
    task.current_role = role;
    task.status = "queued";
    task.launch_deferred = undefined;
    task.finished_at = undefined;
    task.error = undefined;
    task.terminal_notification_id = undefined;
    task.terminal_notification_enqueued_at = undefined;
    task.pid = undefined;
    await appendBackgroundMail(task.id, {
      from: "main",
      type: "status",
      body: `Resumed existing task with ${stages.map((stage) => stage.role).join(" -> ")} stage(s) on the existing worktree.`,
    });
    await appendTaskNote(
      task.id,
      `- ${now()}: resumed existing task; appended ${stages.map((stage) => stage.role).join(" -> ")} and spawned ${role}.\n`,
    );
    await writeBackgroundTaskUnlocked(task, task);
    await spawnAndPersistBackgroundWorker(task, role);
    return task;
  });
}
