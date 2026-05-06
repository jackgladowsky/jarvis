// The agent runtime. Owns the long-lived `Agent` instance, resolves the
// configured model, and exposes `handleMessage(text)` to the transport layer.
//
// Phase 3 deliberately uses ONE global Agent for the whole process — every
// chat shares the same conversation history. Phase 4 (DESIGN.md §10)
// replaces this with per-chat session management: a fresh JSONL session per
// chat, time-windowed rotation, summarization on rotation, etc. The
// transport-layer per-chat mutex (lib/mutex.ts) is forward-compatible with
// that change.

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { getApiKeyForProvider } from "./auth.js";
import { systemPrompt } from "./system-prompt.js";
import { allTools } from "./tools/index.js";

// Register pi-ai's built-in providers (anthropic, openai-codex, etc.) so
// `getModel(provider, id)` can find them. Must run before resolveModel().
registerBuiltInApiProviders();

// Maps the friendly config string to pi-ai's provider key. The auth module
// keys off the same provider strings — keep these in sync.
const PROVIDER_KEY: Record<string, string> = {
  codex: "openai-codex",
  anthropic: "anthropic",
};

function resolveModel(): Model<any> {
  const providerKey = PROVIDER_KEY[config.agent.provider];
  if (!providerKey) {
    throw new Error(`unknown agent.provider: ${config.agent.provider}`);
  }
  // pi-ai's getModel uses literal-typed lookups; our config strings are dynamic,
  // so we cast to satisfy the registry's KnownProvider/model-id constraints.
  const m = getModel(providerKey as any, config.agent.model as any);
  if (!m) {
    throw new Error(
      `model "${config.agent.model}" not found in provider "${providerKey}"`,
    );
  }
  return m;
}

// One agent for the lifetime of the process. The system prompt and tools
// are baked in at construction; messages accumulate via prompt() calls.
const agent = new Agent({
  initialState: {
    systemPrompt,
    model: resolveModel(),
    tools: allTools,
    // No reasoning-mode budget for v1. Could expose via config later.
    thinkingLevel: "off",
  },
  // pi-agent-core invokes this before each LLM request, after any expiry-based
  // refresh logic in auth.ts. Returning undefined makes the request fail
  // before going out.
  getApiKey: getApiKeyForProvider,
});

// Walk backward through the transcript and pull out the most recent assistant
// message's plain-text content. Tool-call blocks and thinking blocks are
// skipped — Telegram wants a single user-facing string.
function extractAssistantText(): string {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const m = agent.state.messages[i];
    if (m.role !== "assistant") continue;

    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    if (text) return text;
    // Fall back to the error message if the turn ended with stopReason="error".
    if (m.errorMessage) return `[error] ${m.errorMessage}`;
    return "(no text in response)";
  }
  return "(no response)";
}

// Public entrypoint called from transport/telegram.ts under the per-chat lock.
// Awaits the full agent run (any tool calls finish before this returns) and
// hands back the final assistant text.
export async function handleMessage(text: string): Promise<string> {
  log.debug("agent prompt", { length: text.length });
  await agent.prompt(text);
  return extractAssistantText();
}
