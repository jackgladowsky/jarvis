/**
 * Model switching: `/model [provider] [model-id]`.
 */
import type { Context } from "grammy";
import { describeModel, getSupportedProviders, switchModel } from "../../../agent/model.js";
import type { CommandDef, ParsedCommand } from "../registry.js";

export async function handleModel(ctx: Context, parsed: ParsedCommand): Promise<void> {
  const current = describeModel();

  if (parsed.parts.length === 0) {
    await ctx.reply(
      `Current model: ${current}\n\n` +
        `Usage: /model <provider> <model-id>\n` +
        `Providers: ${getSupportedProviders().join(", ")}\n\n` +
        `Examples:\n` +
        `  /model openrouter openai/gpt-4o\n` +
        `  /model openrouter anthropic/claude-sonnet-4\n` +
        `  /model codex gpt-5.4\n` +
        `  /model anthropic claude-sonnet-4-6`,
    );
    return;
  }

  if (parsed.parts.length < 2) {
    await ctx.reply(
      `Usage: /model <provider> <model-id>\n` + `Example: /model openrouter openai/gpt-4o\n` + `Current: ${current}`,
    );
    return;
  }

  const [provider, ...modelParts] = parsed.parts;
  const modelId = modelParts.join(" ");

  try {
    switchModel(provider, modelId);
    await ctx.reply(`Switched model to: ${describeModel()}.`);
  } catch (err) {
    await ctx.reply(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const modelCommands: CommandDef[] = [
  {
    name: "model",
    description: "View or switch the active model provider+id",
    category: "Configuration",
    argsHint: "[provider] [model-id]",
    handler: (ctx, parsed) => handleModel(ctx, parsed),
  },
];
