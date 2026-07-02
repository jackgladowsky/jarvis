// Config toggle callback handler.
//
// Callback data formats:
//   toggle:status:thinking    — set status mode to "thinking"
//   toggle:status:verbose     — set status mode to "verbose"
//   toggle:status:off         — set status mode to "off"
//   toggle:reasoning:off      — set reasoning level to "off"
//   toggle:reasoning:low      — set reasoning level to "low"
//   toggle:reasoning:medium   — set reasoning level to "medium"
//   toggle:reasoning:high     — set reasoning level to "high"
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { getReasoningLevel, switchReasoningLevel, type ReasoningLevel } from "../../../agent/reasoning.js";
import type { StatusMode } from "../../../agent/runtime.js";
import { getStatusMode, setStatusMode } from "../../commands/handlers/state.js";
import { registerCallback } from "../dispatcher.js";

// ── Status mode (thinking/verbose/off) ────────────────────────────────────

export function buildStatusToggleKeyboard(chatId: number): InlineKeyboard {
  const current = getStatusMode(chatId);
  const mk = (mode: StatusMode, label: string) =>
    `${current === mode ? "● " : ""}${label}`;
  return new InlineKeyboard()
    .text(mk("thinking", "Thinking"), "toggle:status:thinking")
    .text(mk("verbose", "Verbose"), "toggle:status:verbose")
    .text(mk("off", "Off"), "toggle:status:off");
}

export function statusToggleLabel(chatId: number): string {
  const mode = getStatusMode(chatId);
  return `Progress updates: ${mode === "off" ? "off" : mode}`;
}

// ── Reasoning level ────────────────────────────────────────────────────────

export function buildReasoningToggleKeyboard(): InlineKeyboard {
  const current = getReasoningLevel();
  const levels: ReasoningLevel[] = ["off", "low", "medium", "high"];
  const labels: Record<ReasoningLevel, string> = {
    off: "Off",
    low: "Low",
    medium: "Medium",
    high: "High",
  };
  const kb = new InlineKeyboard();
  for (const level of levels) {
    const label = `${current === level ? "● " : ""}${labels[level]}`;
    kb.text(label, `toggle:reasoning:${level}`);
  }
  return kb;
}

export function reasoningToggleLabel(): string {
  return `Reasoning: ${getReasoningLevel()}`;
}

// ── Callback handler ───────────────────────────────────────────────────────

async function handleToggleCallback(ctx: Context, data: string): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid chat." }).catch(() => undefined);
    return;
  }

  // Status mode toggles
  if (data === "toggle:status:thinking" || data === "toggle:status:verbose" || data === "toggle:status:off") {
    const mode = data.replace("toggle:status:", "") as StatusMode;
    setStatusMode(chatId, mode);
    await ctx.answerCallbackQuery({ text: `Progress: ${mode === "off" ? "off" : mode}` }).catch(() => undefined);
    await ctx
      .editMessageText(statusToggleLabel(chatId), {
        reply_markup: buildStatusToggleKeyboard(chatId),
      })
      .catch(() => undefined);
    return;
  }

  // Reasoning toggles
  const reasoningMatch = data.match(/^toggle:reasoning:(off|low|medium|high)$/);
  if (reasoningMatch) {
    const level = reasoningMatch[1] as ReasoningLevel;
    switchReasoningLevel(level);
    await ctx.answerCallbackQuery({ text: `Reasoning: ${level}` }).catch(() => undefined);
    await ctx
      .editMessageText(reasoningToggleLabel(), {
        reply_markup: buildReasoningToggleKeyboard(),
      })
      .catch(() => undefined);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Unknown toggle." }).catch(() => undefined);
}

export function registerToggleCallback(): void {
  registerCallback("toggle:", handleToggleCallback);
}
