/**
 * Background worker commands: `/bg`, `/fixbg`, `/tasks`, `/task`,
 * `/answer`, `/cancelbg`. All commands in this group bypass the per-chat
 * lock — they're meta-controls over background tasks and shouldn't queue
 * behind a long agent run.
 */
import type { Context } from "grammy";
import { log } from "../../../lib/logger.js";
import {
  answerBackgroundTask,
  cancelBackgroundTask,
  listBackgroundTasks,
  readBackgroundMail,
  readBackgroundTask,
  resumeBackgroundTask,
  startBackgroundTask,
} from "../../../background/manager.js";
import { renderTask, renderTaskList } from "../../../background/logic.js";
import type { CommandDef, ParsedCommand } from "../registry.js";

async function reply(ctx: Context, body: string): Promise<void> {
  try {
    await ctx.reply(body);
  } catch (err) {
    log.warn("background command reply failed", { err: err instanceof Error ? err.message : err });
  }
}

export async function handleBg(ctx: Context, parsed: ParsedCommand): Promise<void> {
  if (!parsed.args) {
    await reply(ctx, "Usage: /bg <long-running task prompt>");
    return;
  }
  const chatId = ctx.chat!.id;
  const task = await startBackgroundTask(parsed.args, chatId);
  await reply(
    ctx,
    `Started background task ${task.id}.\nPipeline: ${task.pipeline.map((stage) => stage.role).join(" -> ")}\nWorktree: ${task.worktree}\nBranch: ${task.branch}`,
  );
}

export async function handleFixBg(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const [id, requestedRole] = parsed.parts;
  const role = requestedRole === "reviewer" ? "reviewer" : "fixer";
  if (!id || (requestedRole && !["fixer", "reviewer"].includes(requestedRole))) {
    await reply(ctx, "Usage: /fixbg <task-id> [fixer|reviewer]");
    return;
  }
  const task = await resumeBackgroundTask(id, role);
  await reply(
    ctx,
    `Resumed ${task.id}; starting ${role} on existing worktree.\nPipeline: ${task.pipeline.map((stage) => `${stage.role}:${stage.status}`).join(" -> ")}\nWorktree: ${task.worktree}`,
  );
}

export async function handleTasks(ctx: Context): Promise<void> {
  const tasks = await listBackgroundTasks();
  await reply(ctx, renderTaskList(tasks));
}

export async function handleTask(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const id = parsed.parts[0];
  if (!id) {
    await reply(ctx, "Usage: /task <id>");
    return;
  }
  const task = await readBackgroundTask(id);
  const mail = await readBackgroundMail(id, 8);
  const mailText = mail.length
    ? "\n\nRecent mailbox:\n" + mail.map((m) => `- ${m.from}/${m.type}: ${m.body}`).join("\n")
    : "";
  await reply(ctx, `${renderTask(task)}${mailText}`);
}

export async function handleAnswer(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const [id, ...bodyParts] = parsed.parts;
  const body = bodyParts.join(" ").trim();
  if (!id || !body) {
    await reply(ctx, "Usage: /answer <task-id> <answer>");
    return;
  }
  const task = await answerBackgroundTask(id, body);
  await reply(ctx, `Answered ${task.id}; worker resumed.`);
}

export async function handleCancelBg(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const id = parsed.parts[0];
  if (!id) {
    await reply(ctx, "Usage: /cancelbg <task-id>");
    return;
  }
  const task = await cancelBackgroundTask(id);
  await reply(ctx, `Cancelled ${task.id}.`);
}

export const backgroundCommands: CommandDef[] = [
  {
    name: "bg",
    description: "Start a background task from a prompt",
    category: "Background",
    argsHint: "<prompt>",
    bypassLock: true,
    handler: (ctx, parsed) => handleBg(ctx, parsed),
  },
  {
    name: "fixbg",
    description: "Resume a failed background task as fixer or reviewer",
    category: "Background",
    argsHint: "<task-id> [fixer|reviewer]",
    bypassLock: true,
    handler: (ctx, parsed) => handleFixBg(ctx, parsed),
  },
  {
    name: "tasks",
    description: "List background tasks and their statuses",
    category: "Background",
    bypassLock: true,
    handler: (ctx) => handleTasks(ctx),
  },
  {
    name: "task",
    description: "Show a background task's full status + recent mailbox",
    category: "Background",
    argsHint: "<task-id>",
    bypassLock: true,
    handler: (ctx, parsed) => handleTask(ctx, parsed),
  },
  {
    name: "answer",
    description: "Answer a background task that is asking for input",
    category: "Background",
    argsHint: "<task-id> <answer>",
    bypassLock: true,
    handler: (ctx, parsed) => handleAnswer(ctx, parsed),
  },
  {
    name: "cancelbg",
    description: "Cancel a running background task",
    category: "Background",
    argsHint: "<task-id>",
    bypassLock: true,
    handler: (ctx, parsed) => handleCancelBg(ctx, parsed),
  },
];
