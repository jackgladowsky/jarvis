import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { notifyMainOrFallback } from "../lib/internal-notifications.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";
import { advanceGoalAfterBackgroundTask } from "../goals/manager.js";
import { runBackgroundPrompt } from "../agent/runtime.js";
import {
  appendBackgroundMail,
  nextQueuedRole,
  readBackgroundMail,
  readBackgroundTask,
  spawnBackgroundWorker,
  writeBackgroundTask,
} from "./manager.js";
import type { BackgroundRole, BackgroundStage, BackgroundTask, BackgroundTaskStatus } from "./types.js";

async function notify(chatId: number, title: string, body: string): Promise<void> {
  await notifyMainOrFallback({
    source: "background",
    chat_id: chatId,
    title,
    body,
    prompt: body,
    fallback_text: `Background task ${title}.\n\n${body}`,
  });
}

function statusForRole(role: BackgroundRole): BackgroundTaskStatus {
  if (role === "researcher") return "researching";
  if (role === "implementer") return "implementing";
  if (role === "reviewer") return "reviewing";
  return "implementing";
}

function roleInstructions(role: BackgroundRole): string[] {
  switch (role) {
    case "researcher":
      return [
        "Role: researcher.",
        "Understand the repo/problem and produce a concise implementation plan, risks, and files likely involved.",
        "Do not edit files. Do not push, merge, deploy, or restart services.",
        "If this is purely a research task, produce the final answer and mark the stage done.",
      ];
    case "implementer":
      return [
        "Role: implementer.",
        "Implement the requested change in the assigned worktree only.",
        "Use prior researcher output/mailbox context if present.",
        "Run reasonable build/typecheck/tests and record exact commands/results.",
        "Do not push, merge, deploy, or restart services.",
      ];
    case "reviewer":
      return [
        "Role: reviewer.",
        "Review the completed work skeptically. Do not edit files.",
        "Inspect task note, mailbox, git status, git diff/stat, and rerun reasonable checks.",
        "Your final response must start with exactly `VERDICT: ready` or `VERDICT: needs_fix`.",
        "Then summarize scope, checks, risks, and concrete fix instructions if needed.",
      ];
    case "fixer":
      return [
        "Role: fixer.",
        "Make the smallest changes needed to address reviewer feedback in the worktree only.",
        "Run reasonable checks. Do not push, merge, deploy, or restart services.",
      ];
  }
}

function parseReviewVerdict(output: string): "ready" | "needs_fix" {
  const first = output.split("\n", 1)[0]?.toLowerCase() ?? "";
  if (first.includes("verdict: ready")) return "ready";
  return "needs_fix";
}

function stageForRole(task: BackgroundTask, role: BackgroundRole): BackgroundStage {
  let stage = task.pipeline.find(
    (candidate) => candidate.role === role && ["queued", "running"].includes(candidate.status),
  );
  if (!stage) stage = task.pipeline.find((candidate) => candidate.role === role && candidate.status !== "done");
  if (!stage) {
    stage = { role, status: "queued" };
    task.pipeline.push(stage);
  }
  return stage;
}

function buildPrompt(
  task: BackgroundTask,
  role: BackgroundRole,
  notePath: string,
  mailboxPath: string,
  mailText: string,
): string {
  const prior =
    task.pipeline
      .filter((stage) => stage.status === "done" && stage.summary)
      .map((stage) => `## ${stage.role} summary\n${stage.summary}`)
      .join("\n\n") || "(no prior stage summaries)";

  return [
    `Original request:\n${task.prompt}`,
    "",
    `Current role: ${role}`,
    `Pipeline: ${task.pipeline.map((stage) => `${stage.role}:${stage.status}`).join(" -> ")}`,
    `Repo: ${task.repo}`,
    `Worktree: ${task.worktree}`,
    `Branch: ${task.branch}`,
    `Task JSON: ${join(paths.backgroundTasks, `${task.id}.json`)}`,
    `Task note: ${notePath}`,
    `Mailbox JSONL: ${mailboxPath}`,
    "",
    "Prior stage summaries:",
    prior,
    "",
    "Mailbox so far:",
    mailText,
    "",
    "Role instructions:",
    ...roleInstructions(role),
    "",
    "Shared rules:",
    "- Do repo work inside the assigned worktree, not the main checkout.",
    "- Use `cd <worktree> && ...` for git/build/test commands.",
    "- Do not push, merge, deploy, or restart services unless the original request explicitly says to.",
    "- If you need clarification, append a worker/question entry to the mailbox JSONL, set task JSON status to waiting_on_main, update the note, and stop.",
    "- Keep the final response concise: changed files/findings, checks, status, and next action.",
  ].join("\n");
}

async function runStage(taskId: string, role: BackgroundRole): Promise<void> {
  const task = await readBackgroundTask(taskId);
  const stage = stageForRole(task, role);
  stage.status = "running";
  stage.started_at = stage.started_at ?? new Date().toISOString();
  task.current_role = role;
  task.status = statusForRole(role);
  task.started_at = task.started_at ?? new Date().toISOString();
  task.pid = process.pid;
  await writeBackgroundTask(task);

  const notePath = join(paths.backgroundNotes, `${task.id}.md`);
  const mailboxPath = join(paths.backgroundMail, `${task.id}.jsonl`);
  const mail = await readBackgroundMail(task.id, 40);
  const mailText = mail.length
    ? mail.map((m) => `${m.ts} ${m.from}/${m.type}: ${m.body}`).join("\n")
    : "(no mailbox messages yet)";

  const output = await runBackgroundPrompt(
    task.id,
    `${task.name} (${role})`,
    buildPrompt(task, role, notePath, mailboxPath, mailText),
    notePath,
  );
  const latest = await readBackgroundTask(task.id);
  const latestStage = stageForRole(latest, role);
  latestStage.status = "done";
  latestStage.finished_at = new Date().toISOString();
  latestStage.summary = output;
  latest.summary = output;
  await appendBackgroundMail(task.id, {
    from: "worker",
    type: role === "reviewer" ? "review" : "handoff",
    body: `${role}:\n${output}`,
  });

  const nextRole = nextQueuedRole(latest);
  if (role === "reviewer") {
    const verdict = parseReviewVerdict(output);
    latest.review_summary = output;
    latest.current_role = undefined;
    latest.finished_at = new Date().toISOString();
    latest.status = verdict === "ready" ? "ready_for_pr" : "needs_fix";
    await writeBackgroundTask(latest);
    await advanceGoalAfterBackgroundTask(latest.id);
    const prefix = verdict === "ready" ? "ready for PR" : "needs fixes";
    await notify(latest.chat_id, `${latest.id} ${prefix}`, output.slice(0, 2500));
    return;
  }

  if (nextRole) {
    latest.current_role = nextRole;
    latest.status = statusForRole(nextRole);
    latest.pid = spawnBackgroundWorker(latest.id, nextRole);
    await writeBackgroundTask(latest);
    await notify(
      latest.chat_id,
      `${latest.id}: ${role} finished; starting ${nextRole}`,
      `Background task ${latest.id}: ${role} finished; starting ${nextRole}.`,
    );
    return;
  }

  latest.current_role = undefined;
  latest.finished_at = new Date().toISOString();
  latest.status = "done";
  await writeBackgroundTask(latest);
  await advanceGoalAfterBackgroundTask(latest.id);
  await notify(latest.chat_id, `${latest.id} done`, output.slice(0, 2500));
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) throw new Error("usage: worker <task-id> [role]");
  const task = await readBackgroundTask(taskId);
  const role = (process.argv[3] as BackgroundRole | undefined) ?? task.current_role ?? nextQueuedRole(task);
  if (!role) throw new Error(`no queued role for ${taskId}`);

  try {
    await runStage(taskId, role);
  } catch (err) {
    const latest = await readBackgroundTask(taskId).catch(() => task);
    const roleStage = latest.current_role ? stageForRole(latest, latest.current_role) : undefined;
    if (roleStage) {
      roleStage.status = "failed";
      roleStage.error = err instanceof Error ? err.message : String(err);
      roleStage.finished_at = new Date().toISOString();
    }
    latest.status = "failed";
    latest.error = err instanceof Error ? err.message : String(err);
    latest.finished_at = new Date().toISOString();
    await writeBackgroundTask(latest);
    await advanceGoalAfterBackgroundTask(latest.id).catch((goalErr) =>
      log.warn("goal advancement after background failure failed", goalErr),
    );
    await appendBackgroundMail(taskId, { from: "worker", type: "error", body: latest.error });
    await notify(latest.chat_id, `${latest.id} failed`, `Background task ${latest.id} failed: ${latest.error}`).catch(
      (notifyErr) => log.warn("background failure notification failed", notifyErr),
    );
    throw err;
  }
}

main().catch(async (err) => {
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
