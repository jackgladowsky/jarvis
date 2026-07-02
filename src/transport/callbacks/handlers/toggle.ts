// Legacy config toggle button callbacks.
//
// /thinking, /verbose, and /reasoning now use plain command replies instead of
// inline button panels. The old panels were low-value compared with direct
// commands and could hang around in chat history. Keep this handler only to
// clean up stale buttons already sent before this change.
import type { Context } from "grammy";
import { registerCallback } from "../dispatcher.js";

export async function handleLegacyToggleCallback(ctx: Context, _data: string): Promise<void> {
  await ctx
    .answerCallbackQuery({ text: "Buttons removed — use /thinking, /verbose, or /reasoning." })
    .catch(() => undefined);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
}

export function registerToggleCallback(): void {
  registerCallback("toggle:", handleLegacyToggleCallback);
}
