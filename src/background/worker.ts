import { execFile } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { log } from "../lib/logger.js";
import {
  enqueueBackgroundLifecycleNotifications,
  queueBackgroundStatusNotification,
} from "./lifecycle-notifications.js";
import { paths } from "../paths.js";
import { advanceGoalAfterBackgroundTask } from "../goals/manager.js";
import { runBackgroundPrompt, type ModelOverride } from "../agent/runtime.js";
import { config } from "../config.js";
import { appendBackgroundMail, readBackgroundMail, readBackgroundTask, writeBackgroundTask } from "./manager.js";
import { backgroundWorkerInstructions } from "./logic.js";
import type { BackgroundTask } from "./types.js";
import { parseWorkerOutcome, stageMustHalt } from "./worker-logic.js";

const execFileAsync = promisify(execFile);

async function bestEffortGoalAdvance(taskId: string): Promise<void> {
  await advanceGoalAfterBackgroundTask(taskId).catch((err) =>
    log.warn("goal advancement after background task failed", {
      taskId,
      err: err instanceof Error ? err.message : err,
    }),
  );
}

function buildControllerContext(task: BackgroundTask, notePath: string, mailText: string): string {
  return [
    `Task ID: ${task.id}`,
    `Repository: ${task.repo}`,
    `Assigned worktree: ${task.worktree}`,
    `Worker branch: ${task.branch}`,
    task.base_sha ? `Base commit: ${task.base_sha}` : undefined,
    `Task note: ${notePath}`,
    "",
    "Mailbox:",
    mailText,
    "",
    "Worker workflow and boundaries:",
    ...backgroundWorkerInstructions().map((line) => `- ${line}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function classifyCompletedTask(task: BackgroundTask): Promise<"ready_for_pr" | "done"> {
  const { stdout: status } = await execFileAsync("git", ["-C", task.worktree, "status", "--porcelain=v1"], {
    timeout: 10_000,
  });
  if (status.trim()) {
    throw new Error(
      "Worker reported completion with uncommitted changes. Resume it to commit the intended changes and leave a clean worktree.",
    );
  }
  if (!task.base_sha) {
    // Legacy tasks did not record their creation SHA. A clean branch is still
    // publishable, and main JARVIS will verify its diff before pushing.
    return "ready_for_pr";
  }
  try {
    await execFileAsync("git", ["-C", task.worktree, "diff", "--quiet", task.base_sha, "HEAD"], { timeout: 10_000 });
    return "done";
  } catch (err) {
    const exitCode = (err as { code?: unknown }).code;
    if (exitCode === 1) return "ready_for_pr";
    throw err;
  }
}

async function finishFailure(task: BackgroundTask, error: string): Promise<void> {
  task.status = "failed";
  task.pid = undefined;
  task.error = error;
  task.finished_at = new Date().toISOString();
  queueBackgroundStatusNotification(task);
  await writeBackgroundTask(task);
  await appendBackgroundMail(task.id, { from: "worker", type: "error", body: error }).catch(() => undefined);
  await bestEffortGoalAdvance(task.id);
  await enqueueBackgroundLifecycleNotifications(task.id).catch((err) =>
    log.warn("background failure notification enqueue failed", {
      taskId: task.id,
      err: err instanceof Error ? err.message : err,
    }),
  );
}

async function runTask(taskId: string): Promise<void> {
  const task = await readBackgroundTask(taskId);
  task.status = "running";
  task.started_at = task.started_at ?? new Date().toISOString();
  task.pid = process.pid;
  const notePath = join(paths.backgroundNotes, `${task.id}.md`);
  await writeBackgroundTask(task);

  const mail = await readBackgroundMail(task.id, 40);
  const mailText = mail.length
    ? mail.map((entry) => `${entry.ts} ${entry.from}/${entry.type}: ${entry.body}`).join("\n")
    : "(no mailbox messages yet)";
  const modelOverride: ModelOverride = config.background?.model ?? {};
  if (modelOverride.provider && modelOverride.model) {
    await appendFile(
      notePath,
      `- ${new Date().toISOString()}: worker routed to ${modelOverride.provider}/${modelOverride.model}.\n`,
      "utf-8",
    );
  }

  const output = await runBackgroundPrompt(
    task.id,
    task.name,
    task.prompt,
    buildControllerContext(task, notePath, mailText),
    notePath,
    modelOverride,
  );
  const latest = await readBackgroundTask(task.id);
  if (stageMustHalt(latest)) {
    latest.pid = undefined;
    await writeBackgroundTask(latest);
    return;
  }

  const outcome = parseWorkerOutcome(output);
  if (outcome !== "completed") {
    const reason =
      outcome === "blocked"
        ? output.replace(/\n?OUTCOME:\s*blocked\s*$/i, "").trim()
        : "Worker returned no valid final OUTCOME marker. Inspect its output before deciding whether to resume.";
    latest.status = "waiting_on_main";
    latest.pid = undefined;
    latest.summary = output;
    latest.error = outcome === "invalid" ? reason : undefined;
    queueBackgroundStatusNotification(latest);
    await writeBackgroundTask(latest);
    await appendBackgroundMail(latest.id, { from: "worker", type: "question", body: reason }).catch(() => undefined);
    await enqueueBackgroundLifecycleNotifications(latest.id);
    return;
  }

  latest.summary = output;
  await appendBackgroundMail(latest.id, { from: "worker", type: "handoff", body: output }).catch(() => undefined);
  try {
    latest.status = await classifyCompletedTask(latest);
  } catch (err) {
    await finishFailure(latest, err instanceof Error ? err.message : String(err));
    return;
  }
  latest.pid = undefined;
  latest.finished_at = new Date().toISOString();
  latest.error = undefined;
  queueBackgroundStatusNotification(latest);
  await writeBackgroundTask(latest);
  await bestEffortGoalAdvance(latest.id);
  await enqueueBackgroundLifecycleNotifications(latest.id);
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) throw new Error("usage: worker <task-id>");
  const task = await readBackgroundTask(taskId);
  try {
    await runTask(taskId);
  } catch (err) {
    const latest = await readBackgroundTask(taskId).catch(() => task);
    if (stageMustHalt(latest)) {
      latest.pid = undefined;
      await writeBackgroundTask(latest).catch(() => undefined);
      return;
    }
    await finishFailure(latest, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) {
  void main().catch(async (err) => {
    log.error("background worker fatal", { err: err instanceof Error ? err.message : err });
    try {
      await mkdir(paths.background, { recursive: true });
      await appendFile(
        join(paths.background, "worker-errors.log"),
        `${new Date().toISOString()} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        "utf-8",
      );
    } catch {
      // nothing useful left to do
    }
    process.exit(1);
  });
}
