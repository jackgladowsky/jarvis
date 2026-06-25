/**
 * Session-lifecycle commands: `/new`, `/cancel`.
 */
import type { Context } from "grammy";
import { cancelChatRun, rotateSession } from "../../../agent/runtime.js";
import type { CommandDef } from "../registry.js";

export async function handleNew(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  const sessionId = await rotateSession(chatId);
  await ctx.reply(`Started a new session (${sessionId}).`);
}

export async function handleCancel(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  const cancelled = cancelChatRun(chatId);
  await ctx.reply(cancelled ? "Cancelling…" : "No active run to cancel.");
}

export const sessionCommands: CommandDef[] = [
  {
    name: "new",
    description: "Start a new session (fresh session id + history)",
    category: "Session",
    handler: (ctx) => handleNew(ctx),
  },
  {
    name: "cancel",
    description: "Cancel the currently-running agent task",
    category: "Session",
    bypassLock: true,
    handler: (ctx) => handleCancel(ctx),
  },
];
