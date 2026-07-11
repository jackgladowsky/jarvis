import type { Context } from "grammy";
import { decideWorkbenchApproval } from "../../../workbench/approval.js";
import { registerCallback } from "../dispatcher.js";

const PREFIX = "wbap:";

export async function handleWorkbenchApproval(ctx: Context, data: string): Promise<void> {
  const match = /^wbap:([ad]):([a-f0-9]{24})$/.exec(data);
  if (!match || !ctx.chat || !ctx.from) {
    await ctx.answerCallbackQuery({ text: "Invalid or expired approval." });
    return;
  }
  const decision = match[1] === "a" ? "approved" : "denied";
  const record = await decideWorkbenchApproval(match[2], { chatId: ctx.chat.id, userId: ctx.from.id }, decision);
  await ctx.answerCallbackQuery({ text: decision === "approved" ? "Approved once." : "Denied." });
  await ctx
    .editMessageText(
      decision === "approved"
        ? `Plan approved once until ${record.expiresAt}. Tell JARVIS to continue.`
        : "Plan denied.",
    )
    .catch(() => undefined);
}

export function registerWorkbenchApprovalCallback(): void {
  registerCallback(PREFIX, handleWorkbenchApproval);
}
