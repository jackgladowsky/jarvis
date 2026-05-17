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

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";
import { getApiKeyForProvider } from "./auth.js";
import { maybeCompact } from "./compaction.js";
import * as sessions from "./session-manager.js";
import { summarizeArchived } from "./summarizer.js";
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
export type StatusMode = "off" | "thinking" | "verbose";

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
  /** Called when the agent terminates a turn with stopReason "error" or
   *  "aborted". `text` is a user-facing summary — surface it instead of the
   *  empty assistant message that would otherwise be silent. */
  onError?: (text: string) => void | Promise<void>;
  /** Optional coarse progress telemetry. This is observable state, not model
   *  chain-of-thought: loading context, calling tools, finishing, etc. */
  onStatus?: (text: string) => void | Promise<void>;
  statusMode?: StatusMode;
}

const activeChatAgents = new Map<number, Agent>();

export function cancelChatRun(chatId: number): boolean {
  const agent = activeChatAgents.get(chatId);
  if (!agent) return false;
  agent.abort();
  return true;
}

// Best-effort human-readable error text. Provider errors arrive as JSON-tail
// strings ("Codex error: {...}", "Anthropic error: {...}"); pull out the
// inner `error.message` and special-case Codex's usage_limit_reached payload.
function formatAgentError(stopReason: string, errorMessage?: string): string {
  if (!errorMessage) {
    return stopReason === "aborted" ? "Run aborted." : `Error (${stopReason}).`;
  }
  const jsonStart = errorMessage.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const obj = JSON.parse(errorMessage.slice(jsonStart));
      const inner = obj?.error ?? obj;
      if (inner?.type === "usage_limit_reached" && typeof inner.resets_in_seconds === "number") {
        const hours = Math.round(inner.resets_in_seconds / 3600);
        const plan = inner.plan_type ? ` (plan: ${inner.plan_type})` : "";
        return `Usage limit reached${plan}. Resets in ~${hours}h.`;
      }
      if (typeof inner?.message === "string") return inner.message;
    } catch {
      // fall through to raw
    }
  }
  return errorMessage.length > 800 ? `${errorMessage.slice(0, 800)}…` : errorMessage;
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

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  } catch {
    return String(value);
  }
}

function formatStatus(event: AgentEvent, mode: StatusMode): string | undefined {
  if (mode === "off") return undefined;
  switch (event.type) {
    case "agent_start":
      return "Starting";
    case "turn_start":
      return "Thinking";
    case "tool_execution_start":
      return mode === "verbose"
        ? `Running ${event.toolName}: ${compactJson(event.args)}`
        : `Running ${event.toolName}`;
    case "tool_execution_update":
      return mode === "verbose"
        ? `${event.toolName} update: ${compactJson(event.partialResult)}`
        : `Running ${event.toolName}`;
    case "tool_execution_end":
      return event.isError ? `${event.toolName} failed` : `${event.toolName} done`;
    case "agent_end":
      return "Finalizing";
    default:
      return undefined;
  }
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

// Wrap a compaction summary as a synthetic user message that the LLM can
// read. Plain text with delimiter tags so the model knows it's history,
// not the user's current ask.

function scheduledSessionFile(taskId: string): string {
  return join(paths.scheduledJobSessions, `${taskId}.jsonl`);
}

async function loadScheduledMessages(taskId: string): Promise<AgentMessage[]> {
  let raw: string;
  try {
    raw = await readFile(scheduledSessionFile(taskId), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const messages = raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AgentMessage);
  return dropDanglingScheduledToolCalls(messages);
}

function dropDanglingScheduledToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const out = messages.slice();
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.role !== "assistant") break;
    const hasToolCall = (last.content ?? []).some(
      (c: { type: string }) => c.type === "toolCall",
    );
    if (!hasToolCall) break;
    out.pop();
  }
  return out;
}

async function appendScheduledMessages(
  taskId: string,
  messages: AgentMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(paths.scheduledJobSessions, { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await appendFile(scheduledSessionFile(taskId), lines, "utf-8");
}

function makeSummaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<context-summary>\n${summary}\n</context-summary>\n\nThe text above summarizes earlier conversation that has been compacted. Continue from this point.`,
      },
    ],
    timestamp: 0,
  };
}

// Public entrypoint called from transport/telegram.ts under the per-chat
// lock. Resolves the session, runs the agent, persists new messages.
export async function handleMessage(
  chatId: number,
  text: string,
  callbacks: StreamCallbacks = {},
  images: ImageContent[] = [],
): Promise<void> {
  const session = await sessions.resolveSession(chatId);
  log.debug("agent prompt", {
    chatId,
    sessionId: session.sessionId,
    isNew: session.isNew,
    length: text.length,
    imageCount: images.length,
  });
  // If resolveSession just archived an old session, kick off the TOC
  // summarizer in the background. Don't await — the user's new turn
  // shouldn't wait on an extra LLM call. Errors are caught inside.
  if (session.rotatedFrom) {
    void summarizeArchived(session.rotatedFrom, model);
  }

  // Load the session and apply compaction if we're near the context window.
  // `maybeCompact` may run an LLM call to produce a summary, persist a
  // `compaction` entry to the JSONL, and return the trimmed message list.
  const loaded = await sessions.load(session.sessionId);
  const compaction = await maybeCompact(session.sessionId, loaded, model, makeSummaryMessage);
  if (compaction.didCompact) {
    log.info("compaction applied", {
      chatId,
      sessionId: session.sessionId,
      tokensBefore: compaction.tokensBefore,
    });
  }
  const agent = buildAgent(compaction.messages);
  activeChatAgents.set(chatId, agent);

  // Track abandon state per assistant message so the transport gets notified
  // exactly once when a streaming text message turns into a tool call.
  let currentMsgIsAbandoned = false;

  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    const status = formatStatus(event, callbacks.statusMode ?? "off");
    if (status) await callbacks.onStatus?.(status);

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
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        const friendly = formatAgentError(m.stopReason, m.errorMessage);
        log.warn("agent error", {
          chatId,
          sessionId: session.sessionId,
          stopReason: m.stopReason,
          err: m.errorMessage ?? "",
        });
        if (currentMsgIsAbandoned) {
          currentMsgIsAbandoned = false;
        }
        await callbacks.onError?.(friendly);
        return;
      }
      const t = extractText(m.content).trim();
      if (t) await callbacks.onAssistantEnd?.(t);
      return;
    }
  });

  // Snapshot the message-array length before prompting so we can diff and
  // persist exactly the new messages this turn produced.
  const before = agent.state.messages.length;

  try {
    await agent.prompt(text, images);
  } finally {
    unsubscribe();
    if (activeChatAgents.get(chatId) === agent) activeChatAgents.delete(chatId);
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
  if (fresh.rotatedFrom) {
    void summarizeArchived(fresh.rotatedFrom, model);
  }
  return fresh.sessionId;
}

// Scheduled jobs use persistent per-task sessions, independent from Telegram
// chat sessions. No rotation/compaction yet; the first cut mirrors AgentBox's
// useful bit: each task keeps context across runs.
export async function runScheduledPrompt(
  taskId: string,
  taskName: string,
  prompt: string,
  taskNotePath: string,
): Promise<string> {
  const messages = await loadScheduledMessages(taskId);
  const agent = buildAgent(messages);
  const before = agent.state.messages.length;
  let finalText = "";

  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    if (hasToolCall(event.message.content)) return;
    finalText = extractText(event.message.content).trim();
  });

  const taskPrompt = [
    "You are running as a scheduled JARVIS task.",
    "Your output may be sent to Jack as a Telegram notification, so be concise and focus on what is actionable.",
    "Compare against previous runs when relevant.",
    "",
    `Task: ${taskName} (${taskId})`,
    `Task note: ${taskNotePath}`,
    "",
    "Before finishing, update the task note markdown file with the current status, latest run summary, useful observations, and next things to watch. Keep it concise and preserve durable context across runs.",
    "",
    prompt,
  ].join("\n");

  try {
    await agent.prompt(taskPrompt);
  } finally {
    unsubscribe();
  }

  await appendScheduledMessages(taskId, agent.state.messages.slice(before));
  return finalText || "(no output)";
}
