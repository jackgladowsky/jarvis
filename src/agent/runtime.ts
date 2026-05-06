// The agent runtime. Owns the long-lived `Agent` instance, resolves the
// configured model, and exposes `handleMessage(text, callbacks)` to the
// transport layer.
//
// Phase 3.5 added the streaming callback API: the transport subscribes to
// per-assistant-message updates so it can stream the final response into
// Telegram via placeholder edits. The "skip messages with tool calls" rule
// (Jack's preference: only the final answer is shown to the user, never the
// internal tool-call/reasoning steps) lives in this file so the transport
// stays UI-only.
//
// Phase 3 deliberately uses ONE global Agent for the whole process — every
// chat shares the same conversation history. Phase 4 (DESIGN.md §10)
// replaces this with per-chat session management.

import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
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
    thinkingLevel: "off",
  },
  // pi-agent-core invokes this before each LLM request, after any expiry-based
  // refresh logic in auth.ts.
  getApiKey: getApiKeyForProvider,
});

// Streaming callbacks invoked per assistant message. Tool-call messages are
// filtered out before any callback fires — see the listener below.
export interface StreamCallbacks {
  /** Called repeatedly as a text-only assistant message streams in. `text` is
   *  the full accumulated text so far (not a delta). */
  onAssistantUpdate?: (text: string) => void | Promise<void>;
  /** Called once when a text-only assistant message finishes. `text` is the
   *  final value. */
  onAssistantEnd?: (text: string) => void | Promise<void>;
  /** Called when a message that was streaming as text is reclassified as a
   *  tool-call message (a `toolCall` block appeared mid-stream). The transport
   *  should clean up any placeholder UI it had created for it. */
  onAbandon?: () => void | Promise<void>;
}

// Pull plain-text content out of an assistant message, joining multiple text
// blocks. Thinking blocks and tool calls are skipped.
function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// True if this message contains any toolCall block — the signal that this
// message is part of internal reasoning rather than user-facing text.
function hasToolCall(content: ReadonlyArray<{ type: string }>): boolean {
  return content.some((c) => c.type === "toolCall");
}

// Public entrypoint called from transport/telegram.ts under the per-chat lock.
// Subscribes to agent events for the duration of the prompt, invokes the
// passed-in callbacks for streamable assistant messages, and resolves once
// the agent run is fully settled.
export async function handleMessage(
  text: string,
  callbacks: StreamCallbacks = {},
): Promise<void> {
  log.debug("agent prompt", { length: text.length });

  // Per-message bookkeeping. Within a single prompt() call there can be
  // multiple assistant messages (e.g., text → tool call → final text). We
  // track the most recent classification so we know when to fire `onAbandon`.
  let currentMsgIsAbandoned = false;

  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      // New assistant message — reset abandon flag.
      currentMsgIsAbandoned = false;
      return;
    }

    if (event.type === "message_update" && event.message.role === "assistant") {
      const m = event.message;
      if (hasToolCall(m.content)) {
        // First time we see a tool-call block in this message: tell the
        // transport to discard whatever placeholder it had.
        if (!currentMsgIsAbandoned) {
          currentMsgIsAbandoned = true;
          await callbacks.onAbandon?.();
        }
        return;
      }
      // Pure text so far — stream the latest accumulated text.
      const t = extractText(m.content).trim();
      if (t) await callbacks.onAssistantUpdate?.(t);
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const m = event.message;
      // Tool-call messages are not sent to the user. The transcript still
      // contains them — just not for display.
      if (hasToolCall(m.content)) return;
      const t = extractText(m.content).trim();
      if (t) await callbacks.onAssistantEnd?.(t);
      return;
    }
  });

  try {
    await agent.prompt(text);
  } finally {
    unsubscribe();
  }
}
