import type { Context } from "grammy";
import { createSecretDrop } from "../../../secret-drop/service.js";
import type { CommandDef, ParsedCommand } from "../registry.js";

export async function handleSecretDrop(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const [key, rawMinutes] = parsed.parts;
  if (!key || parsed.parts.length > 2) {
    await ctx.reply("Usage: /secretdrop KERNEL_API_KEY [5-10]");
    return;
  }
  const minutes = rawMinutes ? Number(rawMinutes) : 10;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10) {
    await ctx.reply("Expiry must be 5-10 minutes.");
    return;
  }
  const drop = await createSecretDrop(key, minutes, ctx.chat!.id);
  await ctx.reply(
    `Open this one-time secret submission link within ${minutes} minutes:\n${drop.url}\n\nDo not forward it. I will report stored or expired status; the secret itself is never sent to Telegram.`,
  );
}
export const secretDropCommands: CommandDef[] = [
  {
    name: "secretdrop",
    description: "Create a one-time secret submission link",
    category: "Security",
    argsHint: "KERNEL_API_KEY [5-10]",
    handler: handleSecretDrop,
  },
];
