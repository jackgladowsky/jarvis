// The agent runtime. Orchestrates per-chat agent runs against the session
// manager — DESIGN.md §10.
//
// Each handleMessage call:
//   1. Resolve the session for this chat (rotating if stale).
//   2. Load the session's transcript from JSONL.
//   3. Build a fresh Agent with that transcript + system prompt + tools.
//   4. Subscribe for streaming callbacks (passed in by the transport) and
//      filter out tool-call messages so the user sees only the final text.
//   5. Run agent.prompt(text) — pi-agent-core appends new messages to its
//      internal state.
//   6. Diff before/after, append the new messages to the session JSONL,
//      stamp lastMessageAt.
//
// The runtime is stateless across calls — no in-memory Agent map. Sessions
// are reconstructed from disk every time. For typical session lengths this
// is fine; if it ever shows up in profiling, move to a per-session Agent
// cache later.

import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { getApiKeyForProvider } from "./auth.js";
import * as sessions from "./session-manager.js";
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

// Resolve the model once at startup. The same Model<> object is reused
// across every per-chat Agent we build — sessions only differ in transcript.
function resolveModel(): Model<any> {
  const providerKey = PROVIDER_KEY[config.agent.provider];
  if (!providerKey) {
    throw new Error(`unknown agent.provider: ${config.agent.provider}`);
  }
  const m = getModel(providerKey as any, config.agent.model as any);
  if (!m) {
    throw new Error(
      `model "${config.agent.model}" not found in provider "${providerKey}"`,
    );
  }
  return m;
}

const model = resolveModel();

// Streaming callbacks invoked per assistant message. Tool-call messages are
// filtered out before any callback fires — see the listener below.
export interface StreamCallbacks {
  /** Called repeatedly as a text-only assistant message streams in. `text`
   *  is the full accumulated text so far (not a delta). */
  onAssistantUpdate?: (text: string) => void | Promise<void>;
  /** Called once when a text-only assistant message finishes. `text` is the
   *  final value. */
  onAssistantEnd?: (text: string) => void | Promise<void>;
  /** Called when a message that was streaming as text is reclassified as a
   *  tool-call message (a `toolCall` block appeared mid-stream). The transport
   *  should clean up any placeholder UI it had created for it. */
  onAbandon?: () => void | Promise<void>;
}

function extractText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function hasToolCall(content: ReadonlyArray<{ type: string }>): boolean {
  return content.some((c) => c.type === "toolCall");
}

// Build a fresh Agent for a given session. Tools, system prompt, and model
// are constants for the process; transcript is per-session.
function buildAgent(messages: AgentMessage[]): Agent {
  return new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      messages,
      thinkingLevel: "off",
    },
    getApiKey: getApiKeyForProvider,
  });
}

// Public entrypoint called from transport/telegram.ts under the per-chat
// lock. Resolves the session, runs the agent, persists new messages.
export async function handleMessage(
  chatId: number,
  text: string,
  callbacks: StreamCallbacks = {},
): Promise<void> {
  const session = await sessions.resolveSession(chatId);
  log.debug("agent prompt", {
    chatId,
    sessionId: session.sessionId,
    isNew: session.isNew,
    length: text.length,
  });

  const previous = await sessions.loadMessages(session.sessionId);
  const agent = buildAgent(previous);

  // Track abandon state per assistant message so the transport gets notified
  // exactly once when a streaming text message turns into a tool call.
  let currentMsgIsAbandoned = false;

  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      currentMsgIsAbandoned = false;
      return;
    }

    if (event.type === "message_update" && event.message.role === "assistant") {
      const m = event.message;
      if (hasToolCall(m.content)) {
        if (!currentMsgIsAbandoned) {
          currentMsgIsAbandoned = true;
          await callbacks.onAbandon?.();
        }
        return;
      }
      const t = extractText(m.content).trim();
      if (t) await callbacks.onAssistantUpdate?.(t);
      return;
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      const m = event.message;
      // Tool-call messages aren't shown to the user — DESIGN.md §12 streaming
      // rule. Their content is still in the transcript for context.
      if (hasToolCall(m.content)) return;
      const t = extractText(m.content).trim();
      if (t) await callbacks.onAssistantEnd?.(t);
      return;
    }
  });

  // Snapshot the message-array length before prompting so we can diff and
  // persist exactly the new messages this turn produced.
  const before = agent.state.messages.length;

  try {
    await agent.prompt(text);
  } finally {
    unsubscribe();
  }

  // Persist new messages + stamp lastMessageAt. Do this even if the prompt
  // ended in error — the partial transcript is still useful for context on
  // the next turn (and for debugging).
  const newMessages = agent.state.messages.slice(before);
  await sessions.appendMessages(session.sessionId, newMessages);
  await sessions.markActivity(chatId);
}

// Force-rotate a chat's session — bound to the `/new` command in the
// transport. Returns the fresh session id for confirmation messages.
export async function rotateSession(chatId: number): Promise<string> {
  const fresh = await sessions.forceRotate(chatId);
  return fresh.sessionId;
}
