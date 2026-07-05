// Legacy stop button callback handler.
//
// New active chat runs no longer render a stop/cancel inline button, but keep
// this compatibility handler for stale buttons already in chat history.
// If a stale button is tapped during an active run, cancel it and give
// immediate visible feedback; otherwise just remove the old keyboard.
import type { Context } from "grammy";
import { cancelChatRun } from "../../../agent/runtime.js";
import { clearStopButtonMessage } from "../../commands/handlers/state.js";
import { registerCallback } from "../dispatcher.js";

export async function handleStop(ctx: Context, _data: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid chat." }).catch(() => undefined);
    return;
  }

  const cancelled = cancelChatRun(chatId);
  clearStopButtonMessage(chatId);

  await ctx.answerCallbackQuery({ text: cancelled ? "Stopping…" : "Already finished." }).catch(() => undefined);

  // Give immediate visible feedback instead of only removing the inline
  // keyboard. The transport will later replace this with the durable stopped
  // status after the runtime has persisted the cancelled turn.
  if (cancelled) {
    await ctx.editMessageText("⏹ Stopping…", { reply_markup: undefined }).catch(() => undefined);
    return;
  }

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
}

export function registerStopCallback(): void {
  registerCallback("stop", handleStop);
}
