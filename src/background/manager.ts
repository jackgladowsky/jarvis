import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { paths } from "../paths.js";
import { log } from "../lib/logger.js";
import type { BackgroundMailEntry, BackgroundRole, BackgroundStage, BackgroundTask } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_REPO = "/home/jack/jarvis";

function now(): string {
  return new Date().toISOString();
}

const ID_LEFT = [
  "ash", "blue", "bold", "calm", "cedar", "clear", "cove", "dawn", "dusk", "fern",
  "frost", "glow", "gray", "green", "hush", "iron", "jade", "kind", "lake", "lunar",
  "maple", "mint", "moss", "north", "nova", "onyx", "pine", "quiet", "river", "sage",
  "solar", "stone", "swift", "tide", "violet", "west", "wild", "young",
];
const ID_RIGHT = [
  "ant", "bear", "bird", "brook", "comet", "crow", "deer", "dove", "drake", "finch",
  "fox", "frog", "hare", "hawk", "lynx", "mole", "moth", "otter", "owl", "panda",
  "quail", "raven", "seal", "shark", "snail", "sparrow", "swan", "tiger", "trout", "wolf",
];

function friendlyIdFromUuid(uuid: string): string {
  const compact = uuid.replace(/-/g, "");
  const leftIndex = Number.parseInt(compact.slice(0, 8), 16) % ID_LEFT.length;
  const rightIndex = Number.parseInt(compact.slice(8, 16), 16) % ID_RIGHT.length;
  return `${ID_LEFT[leftIndex]}-${ID_RIGHT[rightIndex]}`;
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
  return join(paths.backgroundTasks, `${id}.json`);
}

function mailPath(id: string): string {
  return join(paths.backgroundMail, `${id}.jsonl`);
}

function normalizeTask(task: BackgroundTask): BackgroundTask {
  task.uuid = task.uuid ?? `legacy-${task.id}`;
  task.pipeline = task.pipeline ?? [{ role: "implementer", status: task.status === "awaiting_review" ? "done" : "queued" }, { role: "reviewer", status: "queued" }];
  return task;
}

export async function readBackgroundTask(id: string): Promise<BackgroundTask> {
  return normalizeTask(JSON.parse(await readFile(taskPath(id), "utf-8")) as BackgroundTask);
}

export async function writeBackgroundTask(task: BackgroundTask): Promise<void> {
  await mkdir(paths.backgroundTasks, { recursive: true });
  task.updated_at = now();
  await writeFile(taskPath(task.id), JSON.stringify(task, null, 2) + "\n", "utf-8");
}

export async function appendBackgroundMail(id: string, entry: Omit<BackgroundMailEntry, "ts">): Promise<void> {
  await mkdir(paths.backgroundMail, { recursive: true });
  await appendFile(mailPath(id), JSON.stringify({ ts: now(), ...entry }) + "\n", "utf-8");
}

export async function readBackgroundMail(id: string, limit = 20): Promise<BackgroundMailEntry[]> {
  let raw: string;
  try {
    raw = await readFile(mailPath(id), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw.split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line) as BackgroundMailEntry);
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
  await execFileAsync("git", ["-C", task.repo, "fetch", "origin"]);
  await execFileAsync("git", ["-C", task.repo, "worktree", "add", "-b", task.branch, task.worktree, "HEAD"]);
}

export async function listBackgroundTasks(): Promise<BackgroundTask[]> {
  await mkdir(paths.backgroundTasks, { recursive: true });
  const { stdout } = await execFileAsync("bash", ["-lc", `find ${JSON.stringify(paths.backgroundTasks)} -maxdepth 1 -name '*.json' -type f | sort`]);
  const files = stdout.split("\n").filter(Boolean);
  const tasks = await Promise.all(files.map(async (file) => normalizeTask(JSON.parse(await readFile(file, "utf-8")) as BackgroundTask)));
  return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function spawnBackgroundWorker(id: string, role?: BackgroundRole): number {
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
  child.unref();
  log.info("background worker spawned", { id, role, pid: child.pid });
  return child.pid ?? 0;
}

function choosePipeline(prompt: string): BackgroundStage[] {
  const lower = prompt.toLowerCase();
  const wantsResearch = ["research", "investigate", "explore", "look into", "compare", "brainstorm"].some((word) =>
    lower.includes(word),
  );
  const wantsCode = ["implement", "build", "add", "fix", "update", "change", "pr", "code"].some((word) =>
    lower.includes(word),
  );
  if (wantsResearch && !wantsCode) return [{ role: "researcher", status: "queued" }, { role: "reviewer", status: "queued" }];
  if (wantsResearch && wantsCode) {
    return [
      { role: "researcher", status: "queued" },
      { role: "implementer", status: "queued" },
      { role: "reviewer", status: "queued" },
    ];
  }
  return [{ role: "implementer", status: "queued" }, { role: "reviewer", status: "queued" }];
}

export function nextQueuedRole(task: BackgroundTask): BackgroundRole | undefined {
  return task.pipeline.find((stage) => stage.status === "queued")?.role;
}

export async function startBackgroundTask(prompt: string, chatId: number, repo = DEFAULT_REPO): Promise<BackgroundTask> {
  const { id, uuid } = await createTaskIdentity();
  const branch = `worker/${id}`;
  const worktree = join(paths.backgroundWorktrees, id);
  const pipeline = choosePipeline(prompt);
  const currentRole = nextQueuedRole({ pipeline } as BackgroundTask);
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
    current_role: currentRole,
    created_at: now(),
    updated_at: now(),
  };

  await mkdir(paths.backgroundNotes, { recursive: true });
  await createWorktree(task);
  await writeFile(join(paths.backgroundNotes, `${id}.md`), `# ${task.name}\n\n**Status:** queued\n**Worktree:** ${worktree}\n**Branch:** ${branch}\n**Pipeline:** ${pipeline.map((stage) => stage.role).join(" -> ")}\n\n## Prompt\n${prompt}\n\n## Updates\n- ${now()}: task created.\n`, "utf-8");
  await appendBackgroundMail(id, { from: "main", type: "status", body: `Task created. Pipeline: ${pipeline.map((stage) => stage.role).join(" -> ")}. Worktree prepared.` });
  await writeBackgroundTask(task);
  if (currentRole) {
    task.pid = spawnBackgroundWorker(id, currentRole);
    await writeBackgroundTask(task);
  }
  return task;
}

export async function answerBackgroundTask(id: string, body: string): Promise<BackgroundTask> {
  const task = await readBackgroundTask(id);
  await appendBackgroundMail(id, { from: "main", type: "answer", body });
  task.status = "queued";
  const role = task.current_role ?? nextQueuedRole(task);
  if (role) task.pid = spawnBackgroundWorker(id, role);
  await writeBackgroundTask(task);
  return task;
}

export async function cancelBackgroundTask(id: string): Promise<BackgroundTask> {
  const task = await readBackgroundTask(id);
  if (task.pid) {
    try {
      process.kill(task.pid, "SIGTERM");
    } catch {
      // Already gone. Fine.
    }
  }
  task.status = "cancelled";
  await appendBackgroundMail(id, { from: "main", type: "status", body: "Task cancelled by main JARVIS." });
  await writeBackgroundTask(task);
  return task;
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
  return isPidAlive(task.pid)
    || task.pipeline.some((stage) => stage.status === "running")
    || ["queued", "running", "researching", "implementing", "reviewing", "awaiting_review"].includes(task.status);
}

async function appendTaskNote(id: string, line: string): Promise<void> {
  await mkdir(paths.backgroundNotes, { recursive: true });
  await appendFile(join(paths.backgroundNotes, `${id}.md`), line, "utf-8");
}

export async function resumeBackgroundTask(id: string, role: "fixer" | "reviewer" = "fixer"): Promise<BackgroundTask> {
  const task = await readBackgroundTask(id);
  if (isTaskRunning(task)) throw new Error(`${id} is currently running or queued`);
  if (!["needs_fix", "failed", "waiting_on_main"].includes(task.status)) {
    throw new Error(`${id} cannot be resumed from status ${task.status}; expected needs_fix, failed, or waiting_on_main`);
  }
  if (!task.worktree) throw new Error(`${id} has no worktree recorded`);
  const worktreeStat = await stat(task.worktree).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Error(`${id} worktree does not exist: ${task.worktree}`);
    throw err;
  });
  if (!worktreeStat.isDirectory()) throw new Error(`${id} worktree is not a directory: ${task.worktree}`);

  const stages: BackgroundStage[] = role === "fixer"
    ? [{ role: "fixer", status: "queued" }, { role: "reviewer", status: "queued" }]
    : [{ role: "reviewer", status: "queued" }];
  task.pipeline.push(...stages);
  task.current_role = role;
  task.status = statusForResumeRole(role);
  task.finished_at = undefined;
  task.error = undefined;
  task.pid = undefined;
  await appendBackgroundMail(task.id, {
    from: "main",
    type: "status",
    body: `Resumed existing task with ${stages.map((stage) => stage.role).join(" -> ")} stage(s) on the existing worktree.`,
  });
  await appendTaskNote(task.id, `- ${now()}: resumed existing task; appended ${stages.map((stage) => stage.role).join(" -> ")} and spawned ${role}.\n`);
  await writeBackgroundTask(task);
  task.pid = spawnBackgroundWorker(task.id, role);
  await writeBackgroundTask(task);
  return task;
}

function statusForResumeRole(role: "fixer" | "reviewer"): BackgroundTask["status"] {
  return role === "reviewer" ? "reviewing" : "implementing";
}

function renderPipeline(task: BackgroundTask): string {
  return task.pipeline.map((stage) => `${stage.role}:${stage.status}`).join(" -> ");
}

export function renderTask(task: BackgroundTask): string {
  return [
    `${task.id} — ${task.status}`,
    `UUID: ${task.uuid}`,
    `Pipeline: ${renderPipeline(task)}`,
    task.current_role ? `Current role: ${task.current_role}` : undefined,
    `Branch: ${task.branch}`,
    `Worktree: ${task.worktree}`,
    task.pid ? `PID: ${task.pid}` : undefined,
    task.summary ? `Summary: ${task.summary}` : undefined,
    task.review_summary ? `Review: ${task.review_summary}` : undefined,
    task.error ? `Error: ${task.error}` : undefined,
  ].filter(Boolean).join("\n");
}

export function renderTaskList(tasks: BackgroundTask[]): string {
  if (tasks.length === 0) return "No background tasks.";
  return tasks.slice(0, 10).map((task) => {
    const current = task.current_role ? ` current:${task.current_role}` : "";
    return `${task.id} — ${task.status}${current} — ${renderPipeline(task)} — ${basename(task.worktree)}`;
  }).join("\n");
}
