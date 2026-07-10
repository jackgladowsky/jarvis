import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { notifyMainOrFallback } from "../lib/internal-notifications.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";
import { advanceGoalAfterBackgroundTask } from "../goals/manager.js";
import { runBackgroundPrompt } from "../agent/runtime.js";
import { config } from "../config.js";
import {
  appendBackgroundMail,
  launchBackgroundTask,
  nextQueuedRole,
  readBackgroundMail,
  readBackgroundTask,
  writeBackgroundTask,
} from "./manager.js";
import { appendAutomaticFixerCycle, backgroundModelOverrideForRole, backgroundWorkerInstructions } from "./logic.js";
import type { BackgroundRole, BackgroundStage, BackgroundTask, BackgroundTaskStatus } from "./types.js";
import {
  backgroundLifecycleNotificationId,
  parseReviewVerdict,
  parseWorkerOutcome,
  stageMustHalt,
} from "./worker-logic.js";

async function notify(chatId: number, title: string, body: string, id?: string): Promise<void> {
  await notifyMainOrFallback({
    id,
    source: "background",
    chat_id: chatId,
    title,
    body,
    prompt: body,
    // The title already summarizes the body for progress updates; repeating
    // both in a fallback produced visibly duplicated Telegram notifications.
    fallback_text: body,
  });
}

function statusForRole(role: BackgroundRole): BackgroundTaskStatus {
  if (role === "planner" || role === "researcher") return "researching";
  if (role === "implementer") return "implementing";
  if (role === "reviewer") return "reviewing";
  return "implementing";
}

async function bestEffortNotify(chatId: number, title: string, body: string, id?: string): Promise<boolean> {
  try {
    await notify(chatId, title, body, id);
    return true;
  } catch (err) {
    log.warn("background progress notification failed", {
      title,
      err: err instanceof Error ? err.message : err,
    });
    return false;
  }
}

async function bestEffortGoalAdvance(taskId: string): Promise<void> {
  await advanceGoalAfterBackgroundTask(taskId).catch((err) =>
    log.warn("goal advancement after background task failed", {
      taskId,
      err: err instanceof Error ? err.message : err,
    }),
  );
}

async function launchOrObserve(taskId: string): Promise<BackgroundTask> {
  try {
    return await launchBackgroundTask(taskId);
  } catch (err) {
    // The supervisor may win the launch race between our state commit and
    // this call. Treat an already-launched task as success, not stage failure.
    const current = await readBackgroundTask(taskId);
    if (current.pid) return current;
    throw err;
  }
}

async function acknowledgeTerminalNotification(taskId: string, notificationId: string): Promise<void> {
  const current = await readBackgroundTask(taskId);
  if (current.terminal_notification_id !== notificationId || current.terminal_notification_enqueued_at) return;
  current.terminal_notification_enqueued_at = new Date().toISOString();
  await writeBackgroundTask(current);
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

function buildPrompt(task: BackgroundTask, role: BackgroundRole, notePath: string, mailText: string): string {
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
    `Task note: ${notePath}`,
    "",
    "Prior stage summaries:",
    prior,
    "",
    "Mailbox so far:",
    mailText,
    "",
    "Role instructions:",
    ...backgroundWorkerInstructions(role),
    "",
    "Shared rules:",
    "- Do repo work inside the assigned worktree, not the main checkout.",
    "- Use `cd <worktree> && ...` for git/build/test commands.",
    "- Do not push, merge, deploy, or restart services unless the original request explicitly says to.",
    "- Never edit the task JSON or mailbox JSONL. Those are controller-owned state.",
    "- If you need clarification, include a `QUESTION: ...` line and make the exact final nonempty line `OUTCOME: blocked`.",
    "- If your stage work is complete, make the exact final nonempty line `OUTCOME: completed`.",
    "- Keep the response concise: changed files/findings, checks, status, and next action.",
  ].join("\n");
}

async function runStage(taskId: string, role: BackgroundRole): Promise<void> {
  const task = await readBackgroundTask(taskId);
  const stage = stageForRole(task, role);
  const modelOverride = backgroundModelOverrideForRole(role, config.background?.role_models ?? {});
  stage.status = "running";
  stage.started_at = stage.started_at ?? new Date().toISOString();
  if (modelOverride) {
    stage.model_provider = modelOverride.provider;
    stage.model_id = modelOverride.model;
  }
  task.current_role = role;
  task.status = statusForRole(role);
  task.started_at = task.started_at ?? new Date().toISOString();
  task.pid = process.pid;
  const notePath = join(paths.backgroundNotes, `${task.id}.md`);
  await writeBackgroundTask(task);
  if (modelOverride) {
    await appendFile(
      notePath,
      `- ${new Date().toISOString()}: ${role} stage routed to ${modelOverride.provider}/${modelOverride.model}.\n`,
      "utf-8",
    );
  }

  const mail = await readBackgroundMail(task.id, 40);
  const mailText = mail.length
    ? mail.map((m) => `${m.ts} ${m.from}/${m.type}: ${m.body}`).join("\n")
    : "(no mailbox messages yet)";

  const output = await runBackgroundPrompt(
    task.id,
    `${task.name} (${role})`,
    buildPrompt(task, role, notePath, mailText),
    notePath,
    modelOverride,
  );
  const latest = await readBackgroundTask(task.id);
  const latestStage = stageForRole(latest, role);
  if (stageMustHalt(latest)) {
    latest.pid = undefined;
    if (latest.status === "waiting_on_main") {
      // Answering the question resumes this same role; do not advance to the
      // next queued stage merely because the model returned a final message.
      latest.current_role = role;
      latestStage.status = "queued";
      latestStage.summary = output;
      latest.summary = output;
    }
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
    latest.current_role = role;
    latest.pid = undefined;
    latest.summary = output;
    latest.error = outcome === "invalid" ? reason : undefined;
    latest.terminal_notification_id = backgroundLifecycleNotificationId(latest, "attention");
    latest.terminal_notification_enqueued_at = undefined;
    latestStage.status = "queued";
    latestStage.summary = output;
    await writeBackgroundTask(latest);
    await appendBackgroundMail(task.id, {
      from: "worker",
      type: "question",
      body: reason,
    }).catch((err) =>
      log.warn("background question mailbox append failed", {
        taskId: task.id,
        err: err instanceof Error ? err.message : err,
      }),
    );
    const enqueued = await bestEffortNotify(
      latest.chat_id,
      `${latest.id} is waiting for input`,
      `Background task ${latest.id} stopped before advancing.\n\n${reason.slice(0, 2500)}`,
      latest.terminal_notification_id,
    );
    if (enqueued) {
      await acknowledgeTerminalNotification(latest.id, latest.terminal_notification_id).catch((err) =>
        log.warn("background attention notification acknowledgement failed", err),
      );
    }
    return;
  }

  latestStage.status = "done";
  latestStage.finished_at = new Date().toISOString();
  latestStage.summary = output;
  latest.summary = output;
  await appendBackgroundMail(task.id, {
    from: "worker",
    type: role === "reviewer" ? "review" : "handoff",
    body: `${role}:\n${output}`,
  }).catch((err) =>
    log.warn("background handoff mailbox append failed", {
      taskId: task.id,
      err: err instanceof Error ? err.message : err,
    }),
  );

  if (role === "reviewer") {
    const verdict = parseReviewVerdict(output);
    latest.review_summary = output;
    if (verdict === "needs_fix" && appendAutomaticFixerCycle(latest)) {
      const fixerRole = nextQueuedRole(latest);
      if (!fixerRole) throw new Error(`automatic fixer cycle has no queued stage for ${latest.id}`);
      latest.current_role = fixerRole;
      latest.status = "queued";
      latest.pid = undefined;
      await writeBackgroundTask(latest);
      const launched = await launchOrObserve(latest.id);
      await bestEffortNotify(
        latest.chat_id,
        `${latest.id}: review needs fixes; automatic fixer ${launched.pid ? "started" : "queued"}`,
        `Background task ${latest.id}: review needs fixes; its one automatic fixer + final review cycle is ${launched.pid ? "starting" : "queued for worker capacity"}.`,
      );
      return;
    }

    latest.current_role = undefined;
    latest.pid = undefined;
    latest.finished_at = new Date().toISOString();
    latest.status = verdict === "ready" ? "ready_for_pr" : "needs_fix";
    latest.terminal_notification_id = backgroundLifecycleNotificationId(latest, `terminal-${latest.status}`);
    latest.terminal_notification_enqueued_at = undefined;
    await writeBackgroundTask(latest);
    await bestEffortGoalAdvance(latest.id);
    const prefix = verdict === "ready" ? "ready for PR" : "needs fixes";
    const enqueued = await bestEffortNotify(
      latest.chat_id,
      `${latest.id} ${prefix}`,
      output.slice(0, 2500),
      latest.terminal_notification_id,
    );
    if (enqueued) {
      await acknowledgeTerminalNotification(latest.id, latest.terminal_notification_id).catch((err) =>
        log.warn("background terminal notification acknowledgement failed", err),
      );
    }
    return;
  }

  const nextRole = nextQueuedRole(latest);
  if (nextRole) {
    latest.current_role = nextRole;
    latest.status = "queued";
    latest.pid = undefined;
    await writeBackgroundTask(latest);
    const launched = await launchOrObserve(latest.id);
    await bestEffortNotify(
      latest.chat_id,
      `${latest.id}: ${role} finished; ${nextRole} ${launched.pid ? "started" : "queued"}`,
      `Background task ${latest.id}: ${role} finished; ${nextRole} is ${launched.pid ? "starting" : "queued for worker capacity"}.`,
    );
    return;
  }

  latest.current_role = undefined;
  latest.pid = undefined;
  latest.finished_at = new Date().toISOString();
  latest.status = "done";
  latest.terminal_notification_id = backgroundLifecycleNotificationId(latest, `terminal-${latest.status}`);
  latest.terminal_notification_enqueued_at = undefined;
  await writeBackgroundTask(latest);
  await bestEffortGoalAdvance(latest.id);
  const enqueued = await bestEffortNotify(
    latest.chat_id,
    `${latest.id} done`,
    output.slice(0, 2500),
    latest.terminal_notification_id,
  );
  if (enqueued) {
    await acknowledgeTerminalNotification(latest.id, latest.terminal_notification_id).catch((err) =>
      log.warn("background terminal notification acknowledgement failed", err),
    );
  }
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
    if (stageMustHalt(latest)) {
      latest.pid = undefined;
      await writeBackgroundTask(latest).catch(() => undefined);
      return;
    }
    const roleStage = latest.current_role ? stageForRole(latest, latest.current_role) : undefined;
    if (roleStage) {
      roleStage.status = "failed";
      roleStage.error = err instanceof Error ? err.message : String(err);
      roleStage.finished_at = new Date().toISOString();
    }
    latest.status = "failed";
    latest.current_role = undefined;
    latest.pid = undefined;
    latest.error = err instanceof Error ? err.message : String(err);
    latest.finished_at = new Date().toISOString();
    latest.terminal_notification_id = backgroundLifecycleNotificationId(latest, "terminal-failed");
    latest.terminal_notification_enqueued_at = undefined;
    await writeBackgroundTask(latest);
    await advanceGoalAfterBackgroundTask(latest.id).catch((goalErr) =>
      log.warn("goal advancement after background failure failed", goalErr),
    );
    await appendBackgroundMail(taskId, { from: "worker", type: "error", body: latest.error });
    const enqueued = await bestEffortNotify(
      latest.chat_id,
      `${latest.id} failed`,
      `Background task ${latest.id} failed: ${latest.error}`,
      latest.terminal_notification_id,
    );
    if (enqueued) {
      await acknowledgeTerminalNotification(latest.id, latest.terminal_notification_id).catch((notifyErr) =>
        log.warn("background failure notification acknowledgement failed", notifyErr),
      );
    }
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
