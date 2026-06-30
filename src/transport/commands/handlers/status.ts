/**
 * Status & usage commands: `/usage`, `/version`, `/thinking`, `/verbose`.
 *
 * The status-mode map (`statusModes`) is shared between these handlers and
 * the streaming indicator in `telegram.ts`. It lives in `./state.ts` so both
 * sides reference the same instance without `telegram.ts` needing to inject
 * getters/setters into the registry.
 */
import type { Context } from "grammy";
import { log } from "../../../lib/logger.js";
import { collectVersionInfo, renderVersionBlock } from "../../../lib/version.js";
import { parseReasoningLevel, switchReasoningLevel, getReasoningLevel } from "../../../agent/reasoning.js";
import { renderUsageReport } from "../../../agent/usage.js";
import { parseModeCommand } from "../../commands.js";
import type { StatusMode } from "../../../agent/runtime.js";
import { getStatusMode, setStatusMode } from "./state.js";
import type { CommandDef, ParsedCommand } from "../registry.js";

export async function handleUsage(ctx: Context): Promise<void> {
  const chatId = ctx.chat!.id;
  try {
    await ctx.reply(await renderUsageReport(chatId));
  } catch (err) {
    log.warn("usage command failed", { chatId, err: err instanceof Error ? err.message : err });
    await ctx.reply(`Usage report failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleVersion(ctx: Context): Promise<void> {
  await ctx.reply(renderVersionBlock(collectVersionInfo()));
}

function modeLabel(mode: StatusMode): string {
  return mode === "off" ? "off" : mode;
}

function resolveNextMode(cmd: "thinking" | "verbose", arg: string): StatusMode | undefined {
  if (["off", "false", "0", "stop"].includes(arg)) return "off";
  if (["on", "true", "1", ""].includes(arg)) return cmd === "verbose" ? "verbose" : "thinking";
  return undefined;
}

export async function handleReasoning(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const arg = parsed.args.trim();
  if (!arg) {
    await ctx.reply(`Reasoning: ${getReasoningLevel()}\nUsage: /reasoning off|low|medium|high`);
    return;
  }

  const next = parseReasoningLevel(arg);
  if (!next) {
    await ctx.reply("Usage: /reasoning off|low|medium|high");
    return;
  }

  const previous = getReasoningLevel();
  switchReasoningLevel(next);
  await ctx.reply(`Reasoning: ${previous} → ${next}`);
}

export async function handleThinkingOrVerbose(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const chatId = ctx.chat!.id;
  const raw = `/${parsed.name}${parsed.args ? " " + parsed.args : ""}`;
  const modeCommand = parseModeCommand(raw);
  if (!modeCommand) {
    await ctx.reply(`Usage: /${parsed.name} [on|off]`);
    return;
  }
  const next = resolveNextMode(modeCommand.command, modeCommand.arg);
  if (next === undefined) {
    await ctx.reply(`Usage: /${parsed.name} [on|off]`);
    return;
  }
  const current = getStatusMode(chatId);
  setStatusMode(chatId, next);
  await ctx.reply(`Progress updates: ${modeLabel(current)} → ${modeLabel(next)}.`);
}

export const statusCommands: CommandDef[] = [
  {
    name: "usage",
    description: "Show token/cost usage for the active session",
    category: "Status",
    handler: (ctx) => handleUsage(ctx),
  },
  {
    name: "version",
    description: "Show JARVIS version, commit, branch, and dirty state",
    category: "Status",
    handler: (ctx) => handleVersion(ctx),
  },

  {
    name: "reasoning",
    description: "Set model reasoning/thinking level",
    category: "Status",
    argsHint: "[off|low|medium|high]",
    handler: (ctx, parsed) => handleReasoning(ctx, parsed),
  },
  {
    name: "thinking",
    description: "Toggle thinking-progress status messages",
    category: "Status",
    argsHint: "[on|off]",
    handler: (ctx, parsed) => handleThinkingOrVerbose(ctx, parsed),
  },
  {
    name: "verbose",
    description: "Toggle verbose tool-call status messages",
    category: "Status",
    argsHint: "[on|off]",
    handler: (ctx, parsed) => handleThinkingOrVerbose(ctx, parsed),
  },
];
