// Model quick-switcher callback handler.
//
// Callback data formats (all prefixed with `model:`):
//   model:set:<provider>|<modelId>   — switch to a specific model
//   model:providers                   — show all providers
//   model:prov:<provider>             — show models for a provider
//   model:fav                          — go back to favorites view
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { describeModel, switchModel, getSupportedProviders } from "../../../agent/model.js";
import { config } from "../../../config.js";
import { log } from "../../../lib/logger.js";
import { registerCallback } from "../dispatcher.js";

interface FavoriteModel {
  label: string;
  provider: string;
  model_id: string;
}

const DEFAULT_FAVORITES: FavoriteModel[] = [
  { label: "GPT-5.6 Terra", provider: "codex", model_id: "gpt-5.6-terra" },
  { label: "GPT-5.6 Sol", provider: "codex", model_id: "gpt-5.6-sol" },
  { label: "GPT-5.6 Luna", provider: "codex", model_id: "gpt-5.6-luna" },
  { label: "DeepSeek V4 Pro", provider: "openrouter", model_id: "deepseek/deepseek-v4-pro" },
  { label: "Qwen3.7 Max", provider: "openrouter", model_id: "qwen/qwen3.7-max" },
  { label: "Gemini 3.5 Flash", provider: "openrouter", model_id: "google/gemini-3.5-flash" },
];

export function getModelFavorites(): FavoriteModel[] {
  return config.telegram.model_favorites?.length ? config.telegram.model_favorites : DEFAULT_FAVORITES;
}

export function buildFavoritesKeyboard(): InlineKeyboard {
  const current = describeModel();
  const favs = getModelFavorites();
  const kb = new InlineKeyboard();

  for (let i = 0; i < favs.length; i++) {
    const fav = favs[i];
    const isActive = current === `${fav.provider}/${fav.model_id}`;
    const label = `${isActive ? "✅ " : ""}${fav.label}`;
    kb.text(label, `model:set:${fav.provider}|${fav.model_id}`);
    // Two buttons per row.
    if (i % 2 === 1 || i === favs.length - 1) kb.row();
  }

  kb.text("⚙ All providers", "model:providers");
  return kb;
}

function buildProvidersKeyboard(): InlineKeyboard {
  const providers = getSupportedProviders();
  const kb = new InlineKeyboard();

  for (let i = 0; i < providers.length; i++) {
    kb.text(providers[i], `model:prov:${providers[i]}`);
    if (i % 2 === 1 || i === providers.length - 1) kb.row();
  }

  kb.text("← Back", "model:fav");
  return kb;
}

function buildProviderModelsKeyboard(provider: string): InlineKeyboard {
  const favs = getModelFavorites();
  const kb = new InlineKeyboard();
  const current = describeModel();

  const models = favs.filter((f) => f.provider === provider);
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const isActive = current === `${m.provider}/${m.model_id}`;
    kb.text(`${isActive ? "✅ " : ""}${m.label}`, `model:set:${m.provider}|${m.model_id}`);
    if (i % 2 === 1 || i === models.length - 1) kb.row();
  }

  // Also offer manual entry hint.
  kb.text("← Back to providers", "model:providers");
  return kb;
}

function parseModelCallback(
  data: string,
): { action: "set" | "providers" | "prov" | "fav"; provider?: string; modelId?: string } | undefined {
  if (data === "model:providers") return { action: "providers" };
  if (data === "model:fav") return { action: "fav" };

  const setMatch = data.match(/^model:set:(.+)\|(.+)$/);
  if (setMatch) return { action: "set", provider: setMatch[1], modelId: setMatch[2] };

  const provMatch = data.match(/^model:prov:(.+)$/);
  if (provMatch) return { action: "prov", provider: provMatch[1] };

  return undefined;
}

async function handleModelCallback(ctx: Context, data: string): Promise<void> {
  const parsed = parseModelCallback(data);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: "Invalid callback." }).catch(() => undefined);
    return;
  }

  switch (parsed.action) {
    case "set": {
      if (!parsed.provider || !parsed.modelId) {
        await ctx.answerCallbackQuery({ text: "Invalid model." }).catch(() => undefined);
        return;
      }
      try {
        switchModel(parsed.provider, parsed.modelId);
        const favs = getModelFavorites();
        const fav = favs.find(
          (f) => f.provider === parsed.provider && f.model_id === parsed.modelId,
        );
        const label = fav?.label ?? describeModel();
        await ctx.answerCallbackQuery({ text: `Switched to ${label}` }).catch(() => undefined);
        // Re-render the favorites keyboard with updated highlighting.
        await ctx
          .editMessageText(`Model: ${describeModel()}`, {
            reply_markup: buildFavoritesKeyboard(),
          })
          .catch(() => undefined);
      } catch (err) {
        await ctx
          .answerCallbackQuery({
            text: `Failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          })
          .catch(() => undefined);
      }
      return;
    }

    case "providers": {
      await ctx.answerCallbackQuery({}).catch(() => undefined);
      await ctx
        .editMessageText("Select a provider:", {
          reply_markup: buildProvidersKeyboard(),
        })
        .catch(() => undefined);
      return;
    }

    case "prov": {
      if (!parsed.provider) {
        await ctx.answerCallbackQuery({ text: "Invalid provider." }).catch(() => undefined);
        return;
      }
      await ctx.answerCallbackQuery({}).catch(() => undefined);
      await ctx
        .editMessageText(`Models for ${parsed.provider}:`, {
          reply_markup: buildProviderModelsKeyboard(parsed.provider),
        })
        .catch(() => undefined);
      return;
    }

    case "fav": {
      await ctx.answerCallbackQuery({}).catch(() => undefined);
      await ctx
        .editMessageText(`Model: ${describeModel()}`, {
          reply_markup: buildFavoritesKeyboard(),
        })
        .catch(() => undefined);
      return;
    }
  }
}

export function registerModelCallback(): void {
  registerCallback("model:", handleModelCallback);
}
