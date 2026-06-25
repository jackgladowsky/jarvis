/**
 * Help command: `/help [category]` — renders the command registry.
 */
import type { Context } from "grammy";
import { renderHelp } from "../registry.js";
import type { CommandDef, ParsedCommand } from "../registry.js";

export async function handleHelp(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const category = parsed.parts[0];
  await ctx.reply(renderHelp(category));
}

export const helpCommands: CommandDef[] = [
  {
    name: "help",
    description: "Show available commands (optionally by category)",
    category: "Info",
    argsHint: "[category]",
    handler: (ctx, parsed) => handleHelp(ctx, parsed),
  },
];
