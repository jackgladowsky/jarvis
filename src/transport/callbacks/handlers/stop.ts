// Stop button callback handler.
//
// When the [⏹ Stop] button is tapped during an active agent run:
//   1. Cancel the run via `cancelChatRun(chatId)`.
//   2. Answer the callback query with a toast.
//   3. Update the button message immediately so the tap has visible feedback.
//
// If the run already finished (race condition), answer with "Already finished."
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
