// Stop button callback handler.
//
// When the [⏹ Stop] button is tapped during an active agent run:
//   1. Cancel the run via `cancelChatRun(chatId)`.
//   2. Answer the callback query with a toast.
//   3. Remove the keyboard from the message (so the button doesn't linger).
//
// If the run already finished (race condition), answer with "Already finished."
import type { Context } from "grammy";
import { cancelChatRun } from "../../../agent/runtime.js";
import { clearStopButtonMessage } from "../../commands/handlers/state.js";
import { registerCallback } from "../dispatcher.js";

async function handleStop(ctx: Context, _data: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid chat." }).catch(() => undefined);
    return;
  }

  const cancelled = cancelChatRun(chatId);
  clearStopButtonMessage(chatId);

  await ctx
    .answerCallbackQuery({ text: cancelled ? "Cancelled." : "Already finished." })
    .catch(() => undefined);

  // Remove the inline keyboard from the message that held the button.
  // If the message was already deleted/edited (race), the error is silently
  // swallowed by the catch.
  await ctx
    .editMessageReplyMarkup({ reply_markup: undefined })
    .catch(() => undefined);
}

export function registerStopCallback(): void {
  registerCallback("stop", handleStop);
}
