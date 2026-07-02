// Background task notification button callbacks.
//
// Callback data format: `bg:<action>:<taskId>`
// Actions:
//   review     — JARVIS reads the worktree, summarizes diff, gives assessment
//   diff        — same as review but focuses on full git diff
//   ship        — two-tap confirm, then merge + deploy
//   confirm     — second tap of ship: actually merge + deploy
//   cancelship  — cancel the ship confirmation
//   letdecide   — JARVIS reads the question, decides, answers the worker
//   answer      — set per-chat flag so next message is relayed to the worker
//   cancel      — calls cancelBackgroundTask(id)
//   autofix     — calls resumeBackgroundTask(id, 'fixer')
//   details     — JARVIS reads task status + mailbox, summarizes in chat
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  answerBackgroundTask,
  cancelBackgroundTask,
  readBackgroundTask,
  resumeBackgroundTask,
} from "../../../background/manager.js";
import { log } from "../../../lib/logger.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "../../../lib/format.js";
import { config } from "../../../config.js";
import { withLock } from "../../../lib/mutex.js";
import { getCallbackContext } from "../context.js";
import { setPendingBackgroundAnswer } from "../../commands/handlers/state.js";
import { registerCallback } from "../dispatcher.js";

function parseBgCallback(data: string): { action: string; taskId: string } | undefined {
  // data = "bg:<action>:<taskId>"
  const parts = data.split(":");
  if (parts.length < 3) return undefined;
  const action = parts[1];
  const taskId = parts.slice(2).join(":");
  if (!action || !taskId) return undefined;
  return { action, taskId };
}

/** Build inline keyboard for a background task notification. */
export function buildBackgroundKeyboard(notification: {
  title: string;
  body: string;
}): InlineKeyboard | undefined {
  const title = notification.title;
  const lower = title.toLowerCase();

  const firstSep = title.search(/[\s:]/);
  const taskId = firstSep === -1 ? title : title.slice(0, firstSep);
  if (!taskId) return undefined;

  if (lower.includes("asking") || lower.includes("question")) {
    return new InlineKeyboard()
      .text("💬 Let JARVIS decide", `bg:letdecide:${taskId}`)
      .text("🧑 Answer yourself", `bg:answer:${taskId}`)
      .row()
      .text("❌ Cancel", `bg:cancel:${taskId}`);
  }

  if (lower.includes("failed") || lower.includes("needs fix")) {
    return new InlineKeyboard()
      .text("🔧 Auto-fix", `bg:autofix:${taskId}`)
      .text("📋 Details", `bg:details:${taskId}`)
      .row()
      .text("❌ Cancel", `bg:cancel:${taskId}`);
  }

  if (lower.includes("done") || lower.includes("ready for pr")) {
    return new InlineKeyboard()
      .text("👁 Review", `bg:review:${taskId}`)
      .text("📋 Diff", `bg:diff:${taskId}`)
      .row()
      .text("🔀 Ship it", `bg:ship:${taskId}`);
  }

  // Transition notifications (e.g. "implementer finished; starting reviewer")
  // — no buttons needed.
  return undefined;
}

async function answerQuickly(ctx: Context, text: string): Promise<void> {
  await ctx.answerCallbackQuery({ text }).catch(() => undefined);
}

async function editToButtons(ctx: Context, text: string, keyboard: InlineKeyboard): Promise<void> {
  const formatted = config.telegram.parse_mode === "HTML" ? markdownToTelegramHtml(text) : text;
  await ctx
    .editMessageText(formatted, {
      parse_mode: config.telegram.parse_mode === "none" ? undefined : config.telegram.parse_mode,
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    })
    .catch(() => undefined);
}

function formatForTelegram(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  if (config.telegram.parse_mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (config.telegram.parse_mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" };
  return { text };
}

async function synthesizeAgentRun(chatId: number, prompt: string): Promise<void> {
  const { bot, handle } = getCallbackContext();
  // Run in background so callback queries are answered quickly, but serialize
  // through the same per-chat lock as normal Telegram messages. This avoids a
  // button-triggered helper run superseding/aborting an active chat run.
  void withLock(chatId, async () => {
    try {
      let sentText = false;
      await handle(chatId, prompt, {
        onAssistantEnd: async (text: string) => {
          for (const part of splitTelegramMarkdown(text)) {
            const formatted = formatForTelegram(part);
            await bot.api.sendMessage(chatId, formatted.text, {
              parse_mode: formatted.parse_mode,
              link_preview_options: { is_disabled: true },
            });
            sentText = true;
          }
        },
        onError: async (text: string) => {
          await bot.api.sendMessage(chatId, `Error: ${text}`);
          sentText = true;
        },
      });
      if (!sentText) await bot.api.sendMessage(chatId, "(no response)");
    } catch (err) {
      log.warn("background callback agent run failed", { chatId, err: err instanceof Error ? err.message : err });
      await bot.api
        .sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`)
        .catch(() => undefined);
    }
  });
}

async function handleBgCallback(ctx: Context, data: string): Promise<void> {
  const parsed = parseBgCallback(data);
  if (!parsed) {
    await answerQuickly(ctx, "Invalid callback.");
    return;
  }
  const { action, taskId } = parsed;
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await answerQuickly(ctx, "Invalid chat.");
    return;
  }

  switch (action) {
    case "review": {
      await answerQuickly(ctx, "Reviewing…");
      const task = await readBackgroundTask(taskId).catch(() => undefined);
      const worktree = task?.worktree ?? `(unknown — check /task ${taskId})`;
      const prompt =
        `Review background task ${taskId}: read the worktree at ${worktree}, run \`git diff\` and \`git log --oneline -5\` in that worktree, summarize the changes, and give your assessment. Be concise.`;
      await synthesizeAgentRun(chatId, prompt);
      return;
    }

    case "diff": {
      await answerQuickly(ctx, "Showing diff…");
      const task = await readBackgroundTask(taskId).catch(() => undefined);
      const worktree = task?.worktree ?? `(unknown — check /task ${taskId})`;
      const prompt =
        `Background task ${taskId} — show the full git diff. Run \`git diff\` in the worktree at ${worktree} and present the output with a brief summary.`;
      await synthesizeAgentRun(chatId, prompt);
      return;
    }

    case "ship": {
      await answerQuickly(ctx, "Confirm needed.");
      await editToButtons(
        ctx,
        `Confirm: merge + deploy \`${taskId}\`?`,
        new InlineKeyboard()
          .text("✅ Confirm", `bg:confirm:${taskId}`)
          .text("❌ Cancel", `bg:cancelship:${taskId}`),
      );
      return;
    }

    case "confirm": {
      await answerQuickly(ctx, "Merging + deploying…");
      const task = await readBackgroundTask(taskId).catch(() => undefined);
      const worktree = task?.worktree ?? "";
      const branch = task?.branch ?? "";
      const prompt =
        `Ship background task ${taskId}. The worktree is at ${worktree} on branch ${branch}. ` +
        `Review the changes (git diff, git log), merge the branch into main, and deploy using scripts/safe-deploy.sh. ` +
        `Do NOT skip the review. If something looks wrong, stop and report instead of deploying.`;
      await synthesizeAgentRun(chatId, prompt);
      return;
    }

    case "cancelship": {
      await answerQuickly(ctx, "Ship cancelled.");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return;
    }

    case "letdecide": {
      await answerQuickly(ctx, "Let JARVIS decide…");
      const task = await readBackgroundTask(taskId).catch(() => undefined);
      const taskNote = task ? `Task note: /home/jack/.jarvis/data/background/notes/${taskId}.md` : "";
      const prompt =
        `Background task ${taskId} is asking a question. ${taskNote}\n` +
        `Read the task context and mailbox, decide the answer, and call answerBackgroundTask with your answer. ` +
        `The mailbox is at /home/jack/.jarvis/data/background/mail/${taskId}.jsonl. Be decisive but careful.`;
      await synthesizeAgentRun(chatId, prompt);
      return;
    }

    case "answer": {
      setPendingBackgroundAnswer(chatId, taskId);
      await answerQuickly(ctx, "Send your answer now.");
      await editToButtons(
        ctx,
        `Waiting for your answer for task \`${taskId}\`…\nSend a message and it will be relayed to the worker.`,
        new InlineKeyboard().text("❌ Cancel", `bg:cancel:${taskId}`),
      );
      return;
    }

    case "cancel": {
      await answerQuickly(ctx, "Cancelling…");
      try {
        await cancelBackgroundTask(taskId);
        await ctx.editMessageText(`Task \`${taskId}\` cancelled.`).catch(() => undefined);
      } catch (err) {
        await ctx
          .editMessageText(`Failed to cancel: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => undefined);
      }
      return;
    }

    case "autofix": {
      await answerQuickly(ctx, "Starting auto-fix…");
      try {
        await resumeBackgroundTask(taskId, "fixer");
        await ctx.editMessageText(`Auto-fix started for \`${taskId}\`.`).catch(() => undefined);
      } catch (err) {
        await ctx
          .editMessageText(`Failed to start fix: ${err instanceof Error ? err.message : String(err)}`)
          .catch(() => undefined);
      }
      return;
    }

    case "details": {
      await answerQuickly(ctx, "Loading details…");
      const prompt =
        `Background task ${taskId} — read the task JSON at /home/jack/.jarvis/data/background/tasks/${taskId}.json ` +
        `and the mailbox at /home/jack/.jarvis/data/background/mail/${taskId}.jsonl. ` +
        `Summarize the task status, what happened, and what's needed next. Be concise.`;
      await synthesizeAgentRun(chatId, prompt);
      return;
    }

    default:
      await answerQuickly(ctx, "Unknown action.");
  }
}

export function registerBackgroundCallback(): void {
  registerCallback("bg:", handleBgCallback);
}
