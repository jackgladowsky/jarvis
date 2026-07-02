// Callback handler context — gives callback handlers access to the bot
// instance and the agent message handler. Set once at startup in
// `runTelegram` before the bot starts polling.
import type { Bot } from "grammy";
import type { handleMessage } from "../../agent/runtime.js";

export type Handler = typeof handleMessage;

interface CallbackContext {
  bot: Bot;
  handle: Handler;
}

let context: CallbackContext | undefined;

export function setCallbackContext(ctx: CallbackContext): void {
  context = ctx;
}

export function getCallbackContext(): CallbackContext {
  if (!context) throw new Error("callback context not initialized — call setCallbackContext first");
  return context;
}
