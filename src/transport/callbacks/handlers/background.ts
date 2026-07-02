// Legacy background task notification button callbacks.
//
// Background task notifications are intentionally plain text now. The old
// action grid (review/diff/ship/auto-fix/answer/etc.) made Telegram messages
// noisy, spawned fragile button-driven agent runs, and left stale controls in
// chat history. Keep only a small compatibility handler so buttons already in
// Jack's chat disappear when tapped instead of lingering.
import type { Context } from "grammy";
import { registerCallback } from "../dispatcher.js";

/**
 * Background notifications no longer attach inline keyboards.
 *
 * This function is kept as an explicit product boundary and for tests: any
 * notification type should render as text only. Use /task, /tasks, /answer,
 * /fixbg, and /cancelbg for follow-up actions.
 */
export function buildBackgroundKeyboard(_notification: { title: string; body: string }): undefined {
  return undefined;
}

export async function handleLegacyBackgroundCallback(ctx: Context, _data: string): Promise<void> {
  await ctx
    .answerCallbackQuery({ text: "Buttons removed — use /task, /answer, /fixbg, or /cancelbg." })
    .catch(() => undefined);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
}

export function registerBackgroundCallback(): void {
  registerCallback("bg:", handleLegacyBackgroundCallback);
}
