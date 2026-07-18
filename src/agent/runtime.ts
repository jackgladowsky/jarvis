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

import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type ImageContent, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import { log } from "../lib/logger.js";
import {
  auditLifecycle,
  payloadDescriptor,
  withLifecycleContext,
  type LifecycleContext,
} from "../lib/lifecycle-audit.js";
import { paths } from "../paths.js";
import { getApiKeyForProvider } from "./auth.js";
import { estimateContextTokens, maybeCompact, maybeCompactLoaded, type MaybeCompactResult } from "./compaction.js";
import { planContext } from "./context-budget.js";
import {
  appendJobCompactionEntry,
  appendJobMessages,
  loadJobSession,
  type JobCompactionEntry,
  type JobLoadedSession,
} from "./job-session.js";
import { model, resolveModel } from "./model.js";
import { getReasoningLevel } from "./reasoning.js";
import { activeAgentRuns, AgentRunAbortError, isAgentRunAbortError, type ActiveAgentRun } from "./run-registry.js";
import * as sessions from "./session-manager.js";
import { summarizeArchived } from "./summarizer.js";
import { getSystemPrompt } from "./system-prompt.js";
import { createToolResultBudgeter } from "./tool-result-budget.js";
import { makeAbortableTool } from "./tools/abortable.js";
import { createBrowserWorkbenchTool, type BrowserWorkbenchAuthority } from "./tools/browser-workbench.js";
import { createConfigControlTool } from "./tools/config-control.js";
import { diagnosticsTool } from "./tools/diagnostics.js";
import { allTools } from "./tools/index.js";
import { createMcpCallTool, summarizeMcpAuditArgs, summarizeMcpAuditError } from "./tools/mcp.js";
import {
  createMcpManagerTool,
  summarizeMcpManagerAuditArgs,
  summarizeMcpManagerAuditError,
} from "./tools/mcp-manager.js";
import { schedulerControlTool } from "./tools/scheduler-control.js";
import { createSearchMemoryTool } from "./tools/search-memory.js";
import { withToolAudit } from "./tools/audited.js";
import { createSendArtifactTool, type ArtifactSender } from "./tools/send-artifact.js";
import {
  beginChatTurn,
  finishChatTurn,
  interruptedTurnHasReplayRisk,
  recordChatToolStart,
  recordChatVisibleOutput,
  renderInterruptedTurnWarning,
  type ChatTurnJournal,
} from "./turn-journal.js";

// Streaming callbacks invoked per assistant message. Tool-call messages are
// filtered out before any callback fires — see the listener below.
export type StatusMode = "off" | "thinking" | "verbose";

export interface ModelOverride {
  provider?: string;
  model?: string;
}

export interface ChatRunCapabilities {
  /** Present only for a real inbound Telegram chat turn. */
  sendArtifact?: ArtifactSender;
  /** Authenticated Telegram owner identity and approval prompt delivery. */
  browserAuthority?: BrowserWorkbenchAuthority;
}

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
  /** Called when the run was explicitly cancelled and a stopped marker has
   *  been persisted to the current session. */
  onCancelled?: (text: string) => void | Promise<void>;
  /** Optional coarse progress updates. This is observable state, not model
   *  chain-of-thought: loading context, calling tools, finishing, etc. */
  onStatus?: (text: string) => void | Promise<void>;
  statusMode?: StatusMode;
}

const cancellableTools = allTools.map((tool) => makeAbortableTool(tool));

export function cancelChatRun(chatId: number): boolean {
  return activeAgentRuns.cancel("chat", chatId, "Cancelled.");
}

export function abortAllActiveRuns(reason = "Shutting down."): number {
  return activeAgentRuns.abortAll(reason);
}

export function activeRunCount(): number {
  return activeAgentRuns.activeCount();
}

export function waitForActiveRuns(timeoutMs: number): Promise<boolean> {
  return activeAgentRuns.waitForIdle(timeoutMs);
}

function ensureNotAborted(run: ActiveAgentRun): void {
  run.throwIfAborted();
}

function shouldSuppressForCancelledRun(run: ActiveAgentRun): boolean {
  return run.signal.aborted || !run.isCurrent();
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

export const STOPPED_BY_USER_TEXT = "⏹ Stopped by user.";

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isAssistantMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "assistant" }> {
  return (message as { role?: string }).role === "assistant";
}

function isToolResultMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "toolResult" }> {
  return (message as { role?: string }).role === "toolResult";
}

function toolCallIds(message: AgentMessage): string[] {
  if (!isAssistantMessage(message)) return [];
  return ((message.content ?? []) as Array<{ type: string; id?: unknown }>)
    .filter((content) => content.type === "toolCall" && typeof content.id === "string")
    .map((content) => content.id as string);
}

function dropUnresolvedToolCallSuffix(messages: AgentMessage[]): AgentMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = toolCallIds(messages[i]);
    if (calls.length === 0) continue;

    const pending = new Set(calls);
    for (let j = i + 1; j < messages.length; j++) {
      const message = messages[j];
      if (!isToolResultMessage(message)) break;
      pending.delete(message.toolCallId);
    }

    if (pending.size > 0) return messages.slice(0, i);
  }
  return messages;
}

function stoppedAssistantMessage(agentModel: Model<any>, reason = "Cancelled."): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: STOPPED_BY_USER_TEXT }],
    api: agentModel.api,
    provider: agentModel.provider,
    model: agentModel.id,
    usage: ZERO_USAGE,
    stopReason: "aborted",
    errorMessage: reason,
    timestamp: Date.now(),
  };
}

export function normalizeCancelledChatMessages(
  messages: AgentMessage[],
  agentModel: Model<any>,
  reason = "Cancelled.",
): AgentMessage[] {
  const kept = dropUnresolvedToolCallSuffix(messages);
  const last = kept.at(-1);
  if (last && isAssistantMessage(last) && last.stopReason === "aborted") {
    return [
      ...kept.slice(0, -1),
      {
        ...last,
        content: [{ type: "text", text: STOPPED_BY_USER_TEXT }],
        stopReason: "aborted",
        errorMessage: reason,
        timestamp: last.timestamp ?? Date.now(),
      },
    ];
  }

  return [...kept, stoppedAssistantMessage(agentModel, reason)];
}

function compactJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const preview = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return item.length > 96 ? `${item.slice(0, 95)}…` : item;
    if (item === null || typeof item !== "object") return item;
    if (seen.has(item)) return "[circular]";
    if (depth >= 2) return "[nested]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 4).map((entry) => preview(entry, depth + 1));
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .slice(0, 8)
        .map(([key, entry]) => [key, preview(entry, depth + 1)]),
    );
  };
  try {
    const text = JSON.stringify(preview(value, 0));
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  } catch {
    return "[unavailable]";
  }
}

function toolRequestDescriptor(tool: string, args: unknown): Record<string, unknown> {
  const descriptor: Record<string, unknown> = { payload: payloadDescriptor(args) };
  if (!args || typeof args !== "object") return descriptor;
  const value = args as Record<string, unknown>;
  if (["read", "write", "edit", "send_artifact"].includes(tool) && typeof value.path === "string") {
    descriptor.resource = { kind: "path", identity: value.path };
  } else if (tool === "web_search" && typeof value.input === "string" && /^https?:\/\//i.test(value.input)) {
    descriptor.resource = { kind: "url", identity: value.input };
  } else if (tool === "mcp_call") {
    descriptor.resource = { kind: "mcp", server: value.server, tool: value.tool };
  }
  return descriptor;
}

function formatStatus(event: AgentEvent, mode: StatusMode): string | undefined {
  if (mode === "off") return undefined;
  switch (event.type) {
    case "agent_start":
      return "Starting";
    case "turn_start":
      return "Thinking";
    case "tool_execution_start":
      return mode === "verbose" ? `Running ${event.toolName}: ${compactJson(event.args)}` : `Running ${event.toolName}`;
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

// ─── Skill-creation nudge ────────────────────────────────────────────────────
// After a turn with ≥3 tool calls, inject an ephemeral system note at the top
// of the next turn's context. The note is NOT persisted to the session JSONL —
// it's recalculated fresh each turn from the actual tool-call count.

const SKILL_NUDGE_THRESHOLD = 3;
const PRIMARY_RETRY_COUNT = 1;
const PRIMARY_RETRY_BASE_DELAY_MS = 750;
const FALLBACK_PROVIDER = "openrouter";
const FALLBACK_MODEL_ID = "deepseek/deepseek-v4-flash";

export type AgentFailureClass = "transient" | "provider_unavailable" | "permanent";

/**
 * Failure surfaced to durable schedulers/controllers. `replaySafe` is false
 * once any tool began or user-visible output may have escaped; callers must
 * never automatically rerun those executions.
 */
export class AgentExecutionError extends Error {
  readonly replaySafe: boolean;
  readonly failureClass: AgentFailureClass;

  constructor(message: string, replaySafe: boolean, failureClass = classifyAgentFailure(message), cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentExecutionError";
    this.replaySafe = replaySafe;
    this.failureClass = failureClass;
  }
}

// Keep retries deliberately narrow. The agent SDK reports provider failures
// as strings from several transports, so classification must handle both
// status codes and common network/provider wording without treating generic
// client errors as retryable.
export function classifyAgentFailure(message: string): AgentFailureClass {
  const lower = message.toLowerCase();
  if (
    /\b(408|409|425|429|500|502|503|504)\b/.test(lower) ||
    lower.includes("server_error") ||
    lower.includes("server error") ||
    lower.includes("overloaded") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("try again later") ||
    lower.includes("rate limit") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up") ||
    lower.includes("network error") ||
    lower.includes("fetch failed")
  ) {
    return "transient";
  }
  if (
    /\b(401|403)\b/.test(lower) ||
    lower.includes("usage_limit_reached") ||
    lower.includes("usage limit") ||
    lower.includes("quota") ||
    lower.includes("insufficient credit") ||
    lower.includes("insufficient balance") ||
    lower.includes("no api key") ||
    lower.includes("api key not found") ||
    lower.includes("credential") ||
    lower.includes("malformed creds") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return "provider_unavailable";
  }
  return "permanent";
}

export interface ReplayBoundary {
  toolStarted: boolean;
  visibleAssistantOutput: boolean;
}

export function isInferenceReplaySafe(boundary: ReplayBoundary): boolean {
  return !boundary.toolStarted && !boundary.visibleAssistantOutput;
}

function isFallbackModelActive(): boolean {
  return model.provider === FALLBACK_PROVIDER && model.id === FALLBACK_MODEL_ID;
}

function countRecentToolCalls(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: Array<{ type: string }> };
    if (m.role === "assistant" && m.content) {
      return m.content.filter((c) => c.type === "toolCall").length;
    }
  }
  return 0;
}

function injectSkillNudge(messages: AgentMessage[]): void {
  const count = countRecentToolCalls(messages);
  if (count < SKILL_NUDGE_THRESHOLD) return;
  // Inject right at the front so the model sees it near the start of context.
  messages.unshift({
    role: "user",
    content: [
      {
        type: "text",
        text: `[system-note: The previous turn involved ${count} tool calls. Consider whether any repeatable procedure here should be captured as a skill. See the Skills section of your system prompt for creation rules.]`,
      },
    ],
    timestamp: 0,
  });
}

// Build a fresh Agent for a given session. Tools and model are process-level;
// the system prompt is reassembled per run so host-local prompt edits are live
// on the next prompt/session.
function assembleSystemPrompt(tools: typeof cancellableTools, telegramChatId?: number): string {
  const hasSendArtifact = tools.some((tool) => tool.name === "send_artifact");
  return telegramChatId
    ? [
        getSystemPrompt(),
        "## Current Transport Context",
        `- Telegram chat ID: \`${telegramChatId}\``,
        "Pass this exact ID to trusted repo scripts that require an explicit notification destination.",
        ...(hasSendArtifact
          ? [
              "- `send_artifact` is available for this inbound chat turn. Use it when the owner asks you to deliver a local file; do not merely return the host path.",
            ]
          : []),
      ].join("\n\n")
    : getSystemPrompt();
}

export function capProviderOutput(
  options: SimpleStreamOptions | undefined,
  outputMaxTokens: number,
): SimpleStreamOptions {
  return { ...options, maxTokens: outputMaxTokens };
}

function buildAgent(
  messages: AgentMessage[],
  agentModel = model,
  sessionId?: string,
  telegramChatId?: number,
  tools = cancellableTools,
  outputMaxTokens = planContext({
    model: agentModel,
    systemPrompt: assembleSystemPrompt(tools, telegramChatId),
    tools,
    history: messages,
  }).breakdown.outputReserve,
): Agent {
  const systemPrompt = assembleSystemPrompt(tools, telegramChatId);
  const toolResultBudgeter = createToolResultBudgeter(agentModel);
  const agent = new Agent({
    initialState: { systemPrompt, model: agentModel, tools, messages, thinkingLevel: getReasoningLevel() },
    getApiKey: getApiKeyForProvider,
    sessionId,
    afterToolCall: toolResultBudgeter,
    // Tool calls frequently mutate the same checkout, browser, or external
    // system. Preserve source order unless a future tool-specific policy can
    // prove a batch is safe to parallelize.
    toolExecution: "sequential",
  });
  // Wrap the Agent's own pi-agent-core-compatible stream function. The repo
  // can temporarily contain two pi-ai patch versions, so importing a second
  // stream implementation directly would produce incompatible stream classes.
  const providerStream = agent.streamFn;
  agent.streamFn = (streamModel, context, options) =>
    providerStream(streamModel, toolResultBudgeter.constrainProviderContext(context), {
      ...options,
      maxTokens: outputMaxTokens,
    });
  return agent;
}

// Wrap a compaction summary as a synthetic user message that the LLM can
// read. Plain text with delimiter tags so the model knows it's history,
// not the user's current ask.

function scheduledSessionFile(taskId: string): string {
  return join(paths.scheduledJobSessions, `${taskId}.jsonl`);
}

async function loadScheduledMessages(taskId: string): Promise<JobLoadedSession> {
  return loadJobSession(scheduledSessionFile(taskId));
}

async function appendScheduledMessages(taskId: string, messages: AgentMessage[]): Promise<void> {
  await appendJobMessages(scheduledSessionFile(taskId), messages);
}

async function appendScheduledSessionCompaction(taskId: string, entry: JobCompactionEntry): Promise<void> {
  await appendJobCompactionEntry(scheduledSessionFile(taskId), entry);
}

async function archiveScheduledSession(taskId: string, reason: string): Promise<string | undefined> {
  const src = scheduledSessionFile(taskId);
  const archiveDir = join(paths.scheduledJobSessions, "archive");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = join(archiveDir, `${taskId}-${stamp}.jsonl`);
  await mkdir(archiveDir, { recursive: true });
  try {
    await rename(src, dst);
    log.warn("archived scheduled session", { taskId, reason, path: dst });
    return dst;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function backgroundSessionFile(taskId: string): string {
  return join(paths.backgroundSessions, `${taskId}.jsonl`);
}

async function loadBackgroundMessages(taskId: string): Promise<JobLoadedSession> {
  return loadJobSession(backgroundSessionFile(taskId));
}

async function appendBackgroundMessages(taskId: string, messages: AgentMessage[]): Promise<void> {
  await appendJobMessages(backgroundSessionFile(taskId), messages);
}

async function persistBackgroundMessages(
  lifecycle: LifecycleContext,
  taskId: string,
  messages: AgentMessage[],
  terminalFailure = false,
): Promise<void> {
  const data = { messages: messages.length, ...(terminalFailure ? { terminal_failure: true } : {}) };
  await withLifecycleContext(lifecycle, () => auditLifecycle("session.persistence", { outcome: "start", data }));
  try {
    await appendBackgroundMessages(taskId, messages);
    await withLifecycleContext(lifecycle, () => auditLifecycle("session.persistence", { outcome: "ok", data }));
  } catch (error) {
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("session.persistence", {
        outcome: "error",
        data: { ...data, error: payloadDescriptor(error instanceof Error ? error.message : error) },
      }),
    );
    throw error;
  }
}

async function appendBackgroundSessionCompaction(taskId: string, entry: JobCompactionEntry): Promise<void> {
  await appendJobCompactionEntry(backgroundSessionFile(taskId), entry);
}

async function archiveBackgroundSession(taskId: string, reason: string): Promise<string | undefined> {
  const src = backgroundSessionFile(taskId);
  const archiveDir = join(paths.backgroundSessions, "archive");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dst = join(archiveDir, `${taskId}-${stamp}.jsonl`);
  await mkdir(archiveDir, { recursive: true });
  try {
    await rename(src, dst);
    log.warn("archived background session", { taskId, reason, path: dst });
    return dst;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function createChatTools(capabilities: ChatRunCapabilities, chatTurn: ChatTurnJournal): typeof cancellableTools {
  const baseChatTools = capabilities.browserAuthority
    ? [
        ...cancellableTools.filter((tool) => !["browser_workbench", "mcp_call"].includes(tool.name)),
        makeAbortableTool(createBrowserWorkbenchTool(capabilities.browserAuthority)),
        makeAbortableTool(createConfigControlTool(capabilities.browserAuthority)),
        makeAbortableTool(diagnosticsTool),
        makeAbortableTool(schedulerControlTool),
        makeAbortableTool(createSearchMemoryTool(capabilities.browserAuthority)),
        makeAbortableTool(
          withToolAudit(createMcpManagerTool(capabilities.browserAuthority), {
            summarizeArgs: summarizeMcpManagerAuditArgs,
            summarizeError: summarizeMcpManagerAuditError,
          }),
        ),
        makeAbortableTool(
          withToolAudit(createMcpCallTool(capabilities.browserAuthority), {
            summarizeArgs: summarizeMcpAuditArgs,
            summarizeError: summarizeMcpAuditError,
          }),
        ),
      ]
    : cancellableTools;
  return capabilities.sendArtifact
    ? [
        ...baseChatTools,
        makeAbortableTool(
          createSendArtifactTool({
            send: capabilities.sendArtifact,
            beforeDelivery: () => recordChatVisibleOutput(chatTurn),
          }),
        ),
      ]
    : baseChatTools;
}

function makeUserPromptMessage(text: string, images: ImageContent[]): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...images],
    timestamp: Date.now(),
  };
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

export function failureFromMessages(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAssistantMessage(message)) continue;
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage) {
      // Keep the raw provider payload for retry classification. Formatting it
      // first can discard useful fields such as `type: server_error`.
      return message.errorMessage ?? message.stopReason;
    }
  }
  return undefined;
}

function detectAgentFailure(agent: Agent, newMessages: AgentMessage[], capturedFailure?: string): string | undefined {
  return capturedFailure ?? agent.state.errorMessage ?? failureFromMessages(newMessages);
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AgentRunAbortError("Cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new AgentRunAbortError("Cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Public entrypoint called from transport/telegram.ts under the per-chat
// lock. Resolves the session, runs the agent, persists new messages.
export async function handleMessage(
  chatId: number,
  text: string,
  callbacks: StreamCallbacks = {},
  images: ImageContent[] = [],
  capabilities: ChatRunCapabilities = {},
): Promise<void> {
  const run = activeAgentRuns.start("chat", chatId);
  let turn: ChatTurnJournal | undefined;
  let lifecycle: LifecycleContext | undefined;
  try {
    ensureNotAborted(run);
    const session = await sessions.resolveSession(chatId);
    ensureNotAborted(run);
    const begunTurn = await beginChatTurn(chatId, session.sessionId, text, images.length);
    const chatTurn = begunTurn.current;
    turn = chatTurn;
    lifecycle = {
      run_id: randomUUID(),
      run_kind: "chat",
      session_id: session.sessionId,
      turn_id: chatTurn.id,
      chat_id: chatId,
    };
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("turn.received", {
        outcome: "start",
        data: {
          prompt: payloadDescriptor(text),
          image_count: images.length,
          authorization: {
            owner_authenticated: Boolean(capabilities.browserAuthority),
            capability_names: Object.keys(capabilities),
          },
        },
      }),
    );
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

    const chatTools = createChatTools(capabilities, chatTurn);
    // Load the session and apply compaction if the complete request envelope
    // (not just transcript text) is near the exact selected model's window.
    const loaded = await sessions.load(session.sessionId);
    ensureNotAborted(run);
    const loadedEffective = loaded.previousSummary
      ? [makeSummaryMessage(loaded.previousSummary), ...loaded.tail]
      : loaded.tail.slice();
    const initialPlan = planContext({
      model,
      systemPrompt: assembleSystemPrompt(chatTools, chatId),
      tools: chatTools,
      history: loadedEffective,
      currentText: text,
      currentImages: images,
    });
    let compaction: MaybeCompactResult;
    try {
      compaction = await maybeCompact(
        session.sessionId,
        loaded,
        model,
        makeSummaryMessage,
        run.signal,
        initialPlan.decision === "compact",
      );
    } catch (err) {
      if (run.signal.aborted || isAgentRunAbortError(err)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      log.error("chat compaction failed; continuing to bounded preflight", {
        chatId,
        sessionId: session.sessionId,
        err: reason,
      });
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("context.compaction", {
          outcome: "error",
          provider: model.provider,
          model: model.id,
          data: { error: payloadDescriptor(reason), source_preserved: true },
        }),
      );
      compaction = {
        messages: loadedEffective,
        didCompact: false,
        tokensBefore: estimateContextTokens(loadedEffective),
      };
    }
    ensureNotAborted(run);
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("context.preflight", {
        outcome: initialPlan.decision === "fits" ? "ok" : initialPlan.decision === "compact" ? "retry" : "error",
        provider: model.provider,
        model: model.id,
        data: {
          plan: initialPlan.breakdown,
          decision: initialPlan.decision,
          compaction: compaction.didCompact,
          blocked: compaction.blockedReason,
        },
      }),
    );
    const compactionAttemptedModels = new Set<string>();
    if (initialPlan.decision === "compact") compactionAttemptedModels.add(initialPlan.model);
    if (compaction.didCompact) {
      log.info("compaction applied", { chatId, sessionId: session.sessionId, tokensBefore: compaction.tokensBefore });
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("context.compaction", {
          outcome: "ok",
          provider: model.provider,
          model: model.id,
          data: {
            tokens_before: compaction.tokensBefore,
            source_preserved: true,
            source_references: compaction.sourceReferences,
          },
        }),
      );
    }
    if (begunTurn.interruptions.length > 0) {
      compaction.messages.unshift({
        role: "user",
        content: [
          {
            type: "text",
            text: begunTurn.interruptions.map((interrupted) => renderInterruptedTurnWarning(interrupted)).join("\n\n"),
          },
        ],
        timestamp: 0,
      });
      const riskyTurnCount = begunTurn.interruptions.filter((interrupted) =>
        interruptedTurnHasReplayRisk(interrupted),
      ).length;
      log.warn("injecting interrupted-turn recovery note", {
        chatId,
        interruptedTurnIds: begunTurn.interruptions.map((interrupted) => interrupted.id),
        riskyTurnCount,
      });
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("run.recovery", {
          outcome: "degraded",
          data: {
            interrupted_turn_ids: begunTurn.interruptions.map((interrupted) => interrupted.id),
            risky_turn_count: riskyTurnCount,
          },
        }),
      );
    }
    // Ephemeral skill nudge: inject before buildAgent so it enters the agent's
    // context this turn. Never persisted to the session JSONL — recalculated
    // fresh each turn from the actual tool-call count.
    injectSkillNudge(compaction.messages);
    type Attempt = { label: string; agentModel: Model<any>; kind: "primary" | "primary_retry" | "fallback" };
    const primaryAttempts: Attempt[] = [
      { label: "primary", agentModel: model, kind: "primary" },
      ...Array.from({ length: PRIMARY_RETRY_COUNT }, (_, i) => ({
        label: `primary retry ${i + 1}/${PRIMARY_RETRY_COUNT}`,
        agentModel: model,
        kind: "primary_retry" as const,
      })),
    ];
    let fallbackAttempt: Attempt | undefined;
    if (!isFallbackModelActive()) {
      // The fallback is optional. Do not turn a known-missing OpenRouter key
      // into one more doomed provider request.
      const fallbackKey = await getApiKeyForProvider(FALLBACK_PROVIDER);
      if (fallbackKey) {
        fallbackAttempt = {
          label: `fallback ${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID}`,
          agentModel: resolveModel(FALLBACK_PROVIDER, FALLBACK_MODEL_ID),
          kind: "fallback",
        };
      }
    }

    const attempts: Attempt[] = [primaryAttempts[0]];
    let completedMessages: AgentMessage[] | undefined;
    let terminalFailure: string | undefined;
    let callbackFailure: Error | undefined;
    let lastError = "agent message failed";

    const invokeCallback = async (
      label: string,
      callback: (() => void | Promise<void>) | undefined,
      critical = false,
    ): Promise<void> => {
      if (!callback) return;
      try {
        await withLifecycleContext(lifecycle!, callback);
      } catch (err) {
        const callbackError = err instanceof Error ? err : new Error(String(err));
        if (critical) callbackFailure ??= callbackError;
        log.error("agent stream callback failed", {
          chatId,
          sessionId: session.sessionId,
          callback: label,
          critical,
          err: callbackError.message,
        });
      }
    };

    for (let i = 0; i < attempts.length; i++) {
      ensureNotAborted(run);
      const attempt = attempts[i];
      const attemptContext: LifecycleContext = { ...lifecycle, attempt_id: `${lifecycle.run_id}:attempt:${i + 1}` };
      let attemptPlan = planContext({
        model: attempt.agentModel,
        systemPrompt: assembleSystemPrompt(chatTools, chatId),
        tools: chatTools,
        history: compaction.messages,
        currentText: text,
        currentImages: images,
      });
      if (attemptPlan.decision === "compact" && !compactionAttemptedModels.has(attemptPlan.model)) {
        compactionAttemptedModels.add(attemptPlan.model);
        const attemptLoaded = await sessions.load(session.sessionId);
        const attemptCompaction = await maybeCompact(
          session.sessionId,
          attemptLoaded,
          attempt.agentModel,
          makeSummaryMessage,
          run.signal,
          true,
        );
        compaction.messages = attemptCompaction.messages;
        if (begunTurn.interruptions.length > 0) {
          compaction.messages.unshift({
            role: "user",
            content: [
              {
                type: "text",
                text: begunTurn.interruptions
                  .map((interrupted) => renderInterruptedTurnWarning(interrupted))
                  .join("\n\n"),
              },
            ],
            timestamp: 0,
          });
        }
        injectSkillNudge(compaction.messages);
        attemptPlan = planContext({
          model: attempt.agentModel,
          systemPrompt: assembleSystemPrompt(chatTools, chatId),
          tools: chatTools,
          history: compaction.messages,
          currentText: text,
          currentImages: images,
        });
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle("context.compaction", {
            outcome: attemptCompaction.didCompact ? "ok" : "error",
            provider: attempt.agentModel.provider,
            model: attempt.agentModel.id,
            data: { blocked: attemptCompaction.blockedReason, exact_attempt: true },
          }),
        );
      }
      await withLifecycleContext(attemptContext, () =>
        auditLifecycle("model.attempt", {
          outcome: "start",
          provider: attempt.agentModel.provider,
          model: attempt.agentModel.id,
          data: { label: attempt.label, context: attemptPlan.breakdown, decision: attemptPlan.decision },
        }),
      );
      if (attemptPlan.decision !== "fits") {
        const capacityFailure = `Context capacity exceeded for ${attemptPlan.model}: ${attemptPlan.reason ?? "request cannot fit"}. Start a new session or reduce the current input.`;
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle("model.attempt", {
            outcome: "error",
            provider: attempt.agentModel.provider,
            model: attempt.agentModel.id,
            data: { failure_class: "context_capacity", reason: attemptPlan.reason },
          }),
        );
        if (fallbackAttempt && attempt.kind !== "fallback") {
          const fallbackPlan = planContext({
            model: fallbackAttempt.agentModel,
            systemPrompt: assembleSystemPrompt(chatTools, chatId),
            tools: chatTools,
            history: compaction.messages,
            currentText: text,
            currentImages: images,
          });
          if (fallbackPlan.decision !== "impossible") {
            // The fallback loop performs its own one-shot exact-envelope
            // compaction when this model has a smaller input ceiling.
            attempts.push(fallbackAttempt);
            continue;
          }
        }
        completedMessages = [makeUserPromptMessage(text, images)];
        terminalFailure = capacityFailure;
        break;
      }
      const agent = buildAgent(
        compaction.messages.slice(),
        attempt.agentModel,
        session.sessionId,
        chatId,
        chatTools,
        attemptPlan.breakdown.outputReserve,
      );
      const detachAgent = run.attachAgent(agent);
      let currentMsgIsAbandoned = false;
      let promptError: string | undefined;
      const replayBoundary: ReplayBoundary = { toolStarted: false, visibleAssistantOutput: false };

      const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        if (shouldSuppressForCancelledRun(run)) return;

        if (event.type === "tool_execution_start") {
          await recordChatToolStart(chatTurn, event.toolName);
          replayBoundary.toolStarted = true;
          await withLifecycleContext(attemptContext, () =>
            auditLifecycle("tool.execution", {
              outcome: "start",
              tool_call_id: event.toolCallId,
              data: {
                tool: event.toolName,
                request: toolRequestDescriptor(event.toolName, event.args),
                authorization: {
                  owner_authenticated: Boolean(capabilities.browserAuthority),
                  approval_policy: "configured",
                },
              },
            }),
          );
        } else if (event.type === "tool_execution_end") {
          await withLifecycleContext(attemptContext, () =>
            auditLifecycle("tool.execution", {
              outcome: run.signal.aborted ? "cancelled" : event.isError ? "error" : "ok",
              tool_call_id: event.toolCallId,
              data: { tool: event.toolName, result: payloadDescriptor(event.result) },
            }),
          );
        }

        const status = formatStatus(event, callbacks.statusMode ?? "off");
        if (status) await invokeCallback("onStatus", () => callbacks.onStatus?.(status));

        if (shouldSuppressForCancelledRun(run)) return;

        if (event.type === "agent_end") {
          const eventError = failureFromMessages(event.messages);
          if (eventError) promptError = eventError;
          return;
        }

        if (event.type === "message_start" && event.message.role === "assistant") {
          currentMsgIsAbandoned = false;
          return;
        }

        if (event.type === "message_update" && event.message.role === "assistant") {
          const m = event.message;
          if (hasToolCall(m.content)) {
            if (!currentMsgIsAbandoned) {
              currentMsgIsAbandoned = true;
              await invokeCallback("onAbandon", callbacks.onAbandon);
            }
            return;
          }
          const t = extractText(m.content).trim();
          if (t && !shouldSuppressForCancelledRun(run) && callbacks.onAssistantUpdate) {
            await recordChatVisibleOutput(chatTurn);
            replayBoundary.visibleAssistantOutput = true;
            await invokeCallback("onAssistantUpdate", () => callbacks.onAssistantUpdate?.(t));
          }
          return;
        }

        if (event.type === "message_end" && event.message.role === "assistant") {
          const m = event.message;
          if (hasToolCall(m.content)) return;
          if (m.stopReason === "error" || m.stopReason === "aborted") {
            promptError = m.errorMessage ?? m.stopReason;
            lastError = promptError;
            log.warn("agent attempt failed", {
              chatId,
              sessionId: session.sessionId,
              attempt: attempt.label,
              model: `${attempt.agentModel.provider}/${attempt.agentModel.id}`,
              stopReason: m.stopReason,
              err: m.errorMessage ?? "",
            });
            if (currentMsgIsAbandoned) currentMsgIsAbandoned = false;
            return;
          }
          const t = extractText(m.content).trim();
          if (t && !shouldSuppressForCancelledRun(run) && callbacks.onAssistantEnd) {
            await recordChatVisibleOutput(chatTurn);
            replayBoundary.visibleAssistantOutput = true;
            await invokeCallback("onAssistantEnd", () => callbacks.onAssistantEnd?.(t), true);
          }
          return;
        }
      });

      const before = agent.state.messages.length;
      let thrownFailure: string | undefined;

      try {
        await withLifecycleContext(attemptContext, () => agent.prompt(text, images));
        ensureNotAborted(run);
      } catch (err) {
        if (run.signal.aborted || isAgentRunAbortError(err)) {
          const cancelledMessages = normalizeCancelledChatMessages(
            agent.state.messages.slice(before),
            attempt.agentModel,
            run.abortReason ?? "Cancelled.",
          );
          await sessions.appendMessages(session.sessionId, cancelledMessages);
          await sessions.markActivity(chatId);
          if (callbacks.onCancelled) await recordChatVisibleOutput(chatTurn);
          await finishChatTurn(chatTurn, "cancelled", run.abortReason ?? "Cancelled.");
          await invokeCallback("onCancelled", () => callbacks.onCancelled?.(STOPPED_BY_USER_TEXT), true);
          throw new AgentRunAbortError(run.abortReason);
        }
        thrownFailure = err instanceof Error ? err.message : String(err);
      } finally {
        unsubscribe();
        detachAgent();
      }

      const newMessages = agent.state.messages.slice(before);
      const failure = thrownFailure ?? detectAgentFailure(agent, newMessages, promptError);
      if (!failure) {
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle("model.attempt", {
            outcome: "ok",
            provider: attempt.agentModel.provider,
            model: attempt.agentModel.id,
            data: { messages: newMessages.length },
          }),
        );
        completedMessages = newMessages;
        terminalFailure = undefined;
        break;
      }

      lastError = failure;
      const failureClass = classifyAgentFailure(failure);
      const replaySafe = isInferenceReplaySafe(replayBoundary);
      log.warn("agent prompt attempt errored", {
        chatId,
        sessionId: session.sessionId,
        attempt: attempt.label,
        model: `${attempt.agentModel.provider}/${attempt.agentModel.id}`,
        failureClass,
        replaySafe,
        toolStarted: replayBoundary.toolStarted,
        visibleAssistantOutput: replayBoundary.visibleAssistantOutput,
        err: lastError,
      });
      await withLifecycleContext(attemptContext, () =>
        auditLifecycle("model.attempt", {
          outcome: "error",
          provider: attempt.agentModel.provider,
          model: attempt.agentModel.id,
          data: { failure_class: failureClass, replay_safe: replaySafe, error: payloadDescriptor(failure) },
        }),
      );

      let next: Attempt | undefined;
      if (replaySafe && failureClass === "transient" && attempt.kind === "primary") {
        next = primaryAttempts[1];
      } else if (
        replaySafe &&
        (failureClass === "transient" || failureClass === "provider_unavailable") &&
        attempt.kind !== "fallback"
      ) {
        next = fallbackAttempt;
      }

      if (next) {
        attempts.push(next);
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle(next.kind === "fallback" ? "model.fallback" : "model.retry", {
            outcome: "retry",
            provider: next.agentModel.provider,
            model: next.agentModel.id,
            data: { from: attempt.label, to: next.label },
          }),
        );
        await invokeCallback("onStatus", () =>
          callbacks.onStatus?.(
            next.kind === "fallback" ? "Primary failed; trying fallback model" : "Model call failed; retrying",
          ),
        );
        if (next.kind === "primary_retry") {
          const delay = PRIMARY_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 250);
          await waitForRetry(delay, run.signal);
        }
        continue;
      }

      // This attempt is terminal. Persist its transcript (including any tool
      // results) but never replay it after a tool or visible response crossed
      // the side-effect boundary.
      completedMessages = newMessages;
      terminalFailure = failure;
      break;
    }

    if (!completedMessages) {
      terminalFailure = lastError;
      completedMessages = [];
    }

    // Persistence is intentionally outside the inference retry loop. A disk
    // failure after a completed tool or delivered answer must never rerun the
    // model and duplicate those effects.
    let persistenceFailure: Error | undefined;
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("session.persistence", {
        outcome: "start",
        data: { messages: completedMessages.length, transcript: "canonical-append-only" },
      }),
    );
    try {
      await sessions.appendMessages(session.sessionId, completedMessages);
      await sessions.markActivity(chatId);
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("session.persistence", { outcome: "ok", data: { messages: completedMessages.length } }),
      );
    } catch (err) {
      persistenceFailure = err instanceof Error ? err : new Error(String(err));
      log.error("failed to persist completed agent turn", {
        chatId,
        sessionId: session.sessionId,
        err: persistenceFailure.message,
      });
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("session.persistence", {
          outcome: "error",
          data: { error: payloadDescriptor(persistenceFailure?.message ?? "unknown persistence failure") },
        }),
      );
    }

    if (terminalFailure && !shouldSuppressForCancelledRun(run) && callbacks.onError) {
      await recordChatVisibleOutput(chatTurn);
    }

    if (!persistenceFailure) {
      await finishChatTurn(chatTurn, terminalFailure ? "failed" : "committed", terminalFailure);
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("turn.finished", {
          outcome: terminalFailure ? "error" : "ok",
          data: terminalFailure ? { error: payloadDescriptor(terminalFailure) } : undefined,
        }),
      );
    }

    if (terminalFailure && !shouldSuppressForCancelledRun(run)) {
      const displayError = formatAgentError("error", terminalFailure);
      await invokeCallback("onError", () => callbacks.onError?.(`Model call failed: ${displayError}`), true);
    }

    if (persistenceFailure) throw persistenceFailure;
    if (callbackFailure) throw callbackFailure;
  } catch (err) {
    if (lifecycle) {
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("run.failure", {
          outcome: run.signal.aborted || isAgentRunAbortError(err) ? "cancelled" : "error",
          data: { error: payloadDescriptor(err instanceof Error ? err.message : String(err)) },
        }),
      );
    }
    if (turn?.status === "running" && !turn.tool_started && !turn.visible_output) {
      const status = run.signal.aborted || isAgentRunAbortError(err) ? "cancelled" : "failed";
      await finishChatTurn(turn, status, err instanceof Error ? err.message : String(err)).catch((journalErr) =>
        log.error("failed to close side-effect-free chat turn journal", {
          chatId,
          turnId: turn?.id,
          err: journalErr instanceof Error ? journalErr.message : String(journalErr),
        }),
      );
    }
    if (!run.signal.aborted && !isAgentRunAbortError(err)) throw err;
    log.info("agent run cancelled", { chatId, reason: run.abortReason ?? "aborted" });
  } finally {
    run.finish();
  }
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
// chat sessions. They share the same compaction format so recurring jobs do
// not grow until they fall out of the model context window.
export async function runScheduledPrompt(
  taskId: string,
  taskName: string,
  prompt: string,
  taskNotePath: string,
  modelOverride: ModelOverride = {},
): Promise<string> {
  const run = activeAgentRuns.start("scheduled", taskId);
  const lifecycle: LifecycleContext = {
    run_id: randomUUID(),
    run_kind: "scheduled",
    session_id: `scheduled:${taskId}`,
    task_id: taskId,
  };
  let toolStarted = false;
  try {
    const taskModel =
      modelOverride.provider && modelOverride.model ? resolveModel(modelOverride.provider, modelOverride.model) : model;
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("turn.received", {
        outcome: "start",
        provider: taskModel.provider,
        model: taskModel.id,
        data: { prompt: payloadDescriptor(prompt), task_name: taskName },
      }),
    );
    const taskPrompt = [
      "You are running as a scheduled JARVIS task.",
      "Your output may be sent to the owner as a Telegram notification, so be concise and focus on what is actionable.",
      "Compare against previous runs when relevant.",
      "",
      `Task: ${taskName} (${taskId})`,
      `Task note: ${taskNotePath}`,
      "",
      "Before finishing, update the task note markdown file with the current status, latest run summary, useful observations, and next things to watch. Keep it concise and preserve durable context across runs.",
      "",
      prompt,
    ].join("\n");
    ensureNotAborted(run);
    const loaded = await loadScheduledMessages(taskId);
    ensureNotAborted(run);
    let initialMessages: AgentMessage[];
    const loadedEffective = loaded.previousSummary
      ? [makeSummaryMessage(loaded.previousSummary), ...loaded.tail]
      : loaded.tail.slice();
    const initialPlan = planContext({
      model: taskModel,
      systemPrompt: assembleSystemPrompt(cancellableTools),
      tools: cancellableTools,
      history: loadedEffective,
      currentText: taskPrompt,
    });
    try {
      const compaction = await maybeCompactLoaded(
        `scheduled:${taskId}`,
        loaded,
        taskModel,
        makeSummaryMessage,
        {
          appendCompaction: (entry) => appendScheduledSessionCompaction(taskId, entry),
          reload: () => loadScheduledMessages(taskId),
        },
        run.signal,
        initialPlan.decision === "compact",
      );
      ensureNotAborted(run);
      if (compaction.didCompact) {
        log.info("scheduled compaction applied", {
          taskId,
          tokensBefore: compaction.tokensBefore,
          tokensAfter: estimateContextTokens(compaction.messages),
        });
      }
      initialMessages = compaction.messages;
    } catch (err) {
      if (run.signal.aborted || isAgentRunAbortError(err)) throw new AgentRunAbortError(run.abortReason);
      const reason = `scheduled compaction failed: ${err instanceof Error ? err.message : String(err)}`;
      await archiveScheduledSession(taskId, reason);
      initialMessages = [];
    }

    const taskPlan = planContext({
      model: taskModel,
      systemPrompt: assembleSystemPrompt(cancellableTools),
      tools: cancellableTools,
      history: initialMessages,
      currentText: taskPrompt,
    });
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("context.preflight", {
        outcome: taskPlan.decision === "fits" ? "ok" : "error",
        provider: taskModel.provider,
        model: taskModel.id,
        data: { decision: taskPlan.decision, plan: taskPlan.breakdown },
      }),
    );
    if (taskPlan.decision !== "fits") {
      throw new AgentExecutionError(
        `Scheduled turn cannot fit ${taskPlan.model}: ${taskPlan.reason}`,
        true,
        "permanent",
      );
    }
    const agent = buildAgent(
      initialMessages,
      taskModel,
      `scheduled:${taskId}`,
      undefined,
      cancellableTools,
      taskPlan.breakdown.outputReserve,
    );
    const detachAgent = run.attachAgent(agent);
    const before = agent.state.messages.length;
    let finalText = "";
    let errorText = "";

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      if (shouldSuppressForCancelledRun(run)) return;
      if (event.type === "tool_execution_start") {
        toolStarted = true;
        await withLifecycleContext(lifecycle, () =>
          auditLifecycle("tool.execution", {
            outcome: "start",
            tool_call_id: event.toolCallId,
            data: {
              tool: event.toolName,
              request: toolRequestDescriptor(event.toolName, event.args),
              authorization: { run_kind: "scheduled" },
            },
          }),
        );
        return;
      }
      if (event.type === "tool_execution_end") {
        await withLifecycleContext(lifecycle, () =>
          auditLifecycle("tool.execution", {
            outcome: run.signal.aborted ? "cancelled" : event.isError ? "error" : "ok",
            tool_call_id: event.toolCallId,
            data: { tool: event.toolName, result: payloadDescriptor(event.result) },
          }),
        );
        return;
      }
      if (event.type === "agent_end") {
        errorText = failureFromMessages(event.messages) ?? errorText;
        return;
      }
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (hasToolCall(event.message.content)) return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        errorText = event.message.errorMessage ?? event.message.stopReason;
        log.warn("scheduled agent error", {
          taskId,
          stopReason: event.message.stopReason,
          err: event.message.errorMessage ?? "",
        });
        return;
      }
      finalText = extractText(event.message.content).trim();
    });

    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("model.attempt", {
        outcome: "start",
        provider: taskModel.provider,
        model: taskModel.id,
        data: { label: "scheduled-primary" },
      }),
    );
    try {
      ensureNotAborted(run);
      await withLifecycleContext(lifecycle, () => agent.prompt(taskPrompt));
      ensureNotAborted(run);
    } finally {
      unsubscribe();
      detachAgent();
    }

    const newMessages = agent.state.messages.slice(before);
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("session.persistence", { outcome: "start", data: { messages: newMessages.length } }),
    );
    try {
      await appendScheduledMessages(taskId, newMessages);
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("session.persistence", { outcome: "ok", data: { messages: newMessages.length } }),
      );
    } catch (error) {
      await withLifecycleContext(lifecycle, () =>
        auditLifecycle("session.persistence", {
          outcome: "error",
          data: { error: payloadDescriptor(error instanceof Error ? error.message : error) },
        }),
      );
      throw error;
    }
    errorText = detectAgentFailure(agent, newMessages, errorText) ?? "";
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("model.attempt", {
        outcome: errorText ? "error" : "ok",
        provider: taskModel.provider,
        model: taskModel.id,
        data: errorText ? { error: payloadDescriptor(errorText) } : { messages: newMessages.length },
      }),
    );
    if (errorText) {
      throw new AgentExecutionError(
        formatAgentError("error", errorText),
        !toolStarted,
        classifyAgentFailure(errorText),
      );
    }
    if (!finalText)
      throw new AgentExecutionError("scheduled agent produced no final output", !toolStarted, "permanent");
    await withLifecycleContext(lifecycle, () => auditLifecycle("turn.finished", { outcome: "ok" }));
    return finalText;
  } catch (err) {
    const cancelled = run.signal.aborted || isAgentRunAbortError(err);
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("turn.finished", {
        outcome: cancelled ? "cancelled" : "error",
        data: { error: payloadDescriptor(err instanceof Error ? err.message : err) },
      }),
    );
    if (cancelled) throw new AgentRunAbortError(run.abortReason);
    if (err instanceof AgentExecutionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentExecutionError(message, !toolStarted, classifyAgentFailure(message), err);
  } finally {
    run.finish();
  }
}

export async function runBackgroundPrompt(
  taskId: string,
  taskName: string,
  prompt: string,
  taskNotePath: string,
  modelOverride: ModelOverride = {},
): Promise<string> {
  const run = activeAgentRuns.start("background", taskId);
  const lifecycle: LifecycleContext = {
    run_id: randomUUID(),
    run_kind: "background",
    session_id: `background:${taskId}`,
    task_id: taskId,
  };
  try {
    const taskModel =
      modelOverride.provider && modelOverride.model ? resolveModel(modelOverride.provider, modelOverride.model) : model;
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("turn.received", {
        outcome: "start",
        provider: taskModel.provider,
        model: taskModel.id,
        data: { prompt: payloadDescriptor(prompt), task_name: taskName },
      }),
    );
    const taskPrompt = [
      "You are running as a background JARVIS worker.",
      "You have one long-running task. Work autonomously, but do not make product/security/destructive decisions by guessing.",
      "The task JSON and mailbox are controller-owned state. Never edit them directly.",
      "If blocked, include a `QUESTION: ...` line and make the exact final nonempty line `OUTCOME: blocked`.",
      "If finished, update only the task note and make the exact final nonempty line `OUTCOME: completed`.",
      "Background workers must never push, merge, deploy, restart services, or edit the main checkout. No explicit request or mailbox message can grant an exception; main JARVIS is the gate.",
      "Use the assigned git worktree for repo changes.",
      "Your final response is a concise handoff summary for main JARVIS.",
      "",
      `Task: ${taskName} (${taskId})`,
      `Task note: ${taskNotePath}`,
      "",
      prompt,
    ].join("\n");
    ensureNotAborted(run);
    const loaded = await loadBackgroundMessages(taskId);
    ensureNotAborted(run);
    let initialMessages: AgentMessage[];
    const loadedEffective = loaded.previousSummary
      ? [makeSummaryMessage(loaded.previousSummary), ...loaded.tail]
      : loaded.tail.slice();
    const initialPlan = planContext({
      model: taskModel,
      systemPrompt: assembleSystemPrompt(cancellableTools),
      tools: cancellableTools,
      history: loadedEffective,
      currentText: taskPrompt,
    });
    try {
      const compaction = await maybeCompactLoaded(
        `background:${taskId}`,
        loaded,
        taskModel,
        makeSummaryMessage,
        {
          appendCompaction: (entry) => appendBackgroundSessionCompaction(taskId, entry),
          reload: () => loadBackgroundMessages(taskId),
        },
        run.signal,
        initialPlan.decision === "compact",
      );
      ensureNotAborted(run);
      if (compaction.didCompact) {
        log.info("background compaction applied", {
          taskId,
          tokensBefore: compaction.tokensBefore,
          tokensAfter: estimateContextTokens(compaction.messages),
        });
      }
      initialMessages = compaction.messages;
    } catch (err) {
      if (run.signal.aborted || isAgentRunAbortError(err)) throw new AgentRunAbortError(run.abortReason);
      const reason = `background compaction failed: ${err instanceof Error ? err.message : String(err)}`;
      await archiveBackgroundSession(taskId, reason);
      initialMessages = [];
    }

    type BackgroundAttempt = {
      label: string;
      agentModel: Model<any>;
      kind: "primary" | "primary_retry" | "fallback";
    };
    const primaryRetry: BackgroundAttempt = {
      label: "primary retry 1/1",
      agentModel: taskModel,
      kind: "primary_retry",
    };
    let fallback: BackgroundAttempt | undefined;
    if (await getApiKeyForProvider("openrouter")) {
      const fallbackModel = resolveModel("openrouter", "z-ai/glm-5.2");
      if (taskModel.provider !== fallbackModel.provider || taskModel.id !== fallbackModel.id) {
        fallback = { label: "fallback openrouter/z-ai/glm-5.2", agentModel: fallbackModel, kind: "fallback" };
      }
    }
    const attempts: BackgroundAttempt[] = [{ label: "primary", agentModel: taskModel, kind: "primary" }];
    let lastError: Error | undefined;

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
      ensureNotAborted(run);
      const attempt = attempts[attemptIndex];
      const attemptModel = attempt.agentModel;
      const attemptContext: LifecycleContext = {
        ...lifecycle,
        attempt_id: `${lifecycle.run_id}:attempt:${attemptIndex + 1}`,
      };
      log.info("background prompt attempt", { taskId, attempt: attempt.label, model: attemptModel.id });

      let attemptPlan = planContext({
        model: attemptModel,
        systemPrompt: assembleSystemPrompt(cancellableTools),
        tools: cancellableTools,
        history: initialMessages,
        currentText: taskPrompt,
      });
      // A smaller fallback gets its own exact-envelope compaction attempt.
      if (attempt.kind === "fallback" && attemptPlan.decision === "compact") {
        const fallbackLoaded = await loadBackgroundMessages(taskId);
        const fallbackCompaction = await maybeCompactLoaded(
          `background:${taskId}`,
          fallbackLoaded,
          attemptModel,
          makeSummaryMessage,
          {
            appendCompaction: (entry) => appendBackgroundSessionCompaction(taskId, entry),
            reload: () => loadBackgroundMessages(taskId),
          },
          run.signal,
          true,
        );
        initialMessages = fallbackCompaction.messages;
        attemptPlan = planContext({
          model: attemptModel,
          systemPrompt: assembleSystemPrompt(cancellableTools),
          tools: cancellableTools,
          history: initialMessages,
          currentText: taskPrompt,
        });
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle("context.compaction", {
            outcome: fallbackCompaction.didCompact ? "ok" : "error",
            provider: attemptModel.provider,
            model: attemptModel.id,
            data: { blocked: fallbackCompaction.blockedReason, fallback: true },
          }),
        );
      }
      const agent = buildAgent(
        initialMessages,
        attemptModel,
        `background:${taskId}`,
        undefined,
        cancellableTools,
        attemptPlan.breakdown.outputReserve,
      );
      const detachAgent = run.attachAgent(agent);
      const before = agent.state.messages.length;
      let finalText = "";
      let errorText = "";
      let toolStarted = false;

      const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        if (shouldSuppressForCancelledRun(run)) return;
        if (event.type === "tool_execution_start") {
          toolStarted = true;
          await withLifecycleContext(attemptContext, () =>
            auditLifecycle("tool.execution", {
              outcome: "start",
              tool_call_id: event.toolCallId,
              data: {
                tool: event.toolName,
                request: toolRequestDescriptor(event.toolName, event.args),
                authorization: { run_kind: "background" },
              },
            }),
          );
          return;
        }
        if (event.type === "tool_execution_end") {
          await withLifecycleContext(attemptContext, () =>
            auditLifecycle("tool.execution", {
              outcome: run.signal.aborted ? "cancelled" : event.isError ? "error" : "ok",
              tool_call_id: event.toolCallId,
              data: { tool: event.toolName, result: payloadDescriptor(event.result) },
            }),
          );
          return;
        }
        if (event.type === "agent_end") {
          errorText = failureFromMessages(event.messages) ?? errorText;
          return;
        }
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        if (hasToolCall(event.message.content)) return;
        if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
          errorText = event.message.errorMessage ?? event.message.stopReason;
          log.warn("background agent error", {
            taskId,
            stopReason: event.message.stopReason,
            err: event.message.errorMessage ?? "",
          });
          return;
        }
        finalText = extractText(event.message.content).trim();
      });

      await withLifecycleContext(attemptContext, () =>
        auditLifecycle("model.attempt", {
          outcome: attemptPlan.decision === "fits" ? "start" : "error",
          provider: attemptModel.provider,
          model: attemptModel.id,
          data: { label: attempt.label, decision: attemptPlan.decision, context: attemptPlan.breakdown },
        }),
      );

      let thrownFailure: string | undefined;
      try {
        ensureNotAborted(run);
        if (attemptPlan.decision !== "fits") {
          throw new Error(`Context capacity exceeded for ${attemptPlan.model}: ${attemptPlan.reason}`);
        }
        await withLifecycleContext(attemptContext, () => agent.prompt(taskPrompt));
        ensureNotAborted(run);
      } catch (err) {
        if (run.signal.aborted || isAgentRunAbortError(err)) throw new AgentRunAbortError(run.abortReason);
        thrownFailure = err instanceof Error ? err.message : String(err);
      } finally {
        unsubscribe();
        detachAgent();
      }

      const newMessages = agent.state.messages.slice(before);
      const failure =
        thrownFailure ??
        detectAgentFailure(agent, newMessages, errorText || undefined) ??
        (!finalText ? "background agent produced no final output" : undefined);
      if (!failure) {
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle("model.attempt", {
            outcome: "ok",
            provider: attemptModel.provider,
            model: attemptModel.id,
            data: { messages: newMessages.length },
          }),
        );
        await persistBackgroundMessages(lifecycle, taskId, newMessages);
        await withLifecycleContext(lifecycle, () => auditLifecycle("turn.finished", { outcome: "ok" }));
        return finalText;
      }

      lastError = new Error(failure);
      const failureClass = classifyAgentFailure(failure);
      await withLifecycleContext(attemptContext, () =>
        auditLifecycle("model.attempt", {
          outcome: "error",
          provider: attemptModel.provider,
          model: attemptModel.id,
          data: { failure_class: failureClass, error: payloadDescriptor(failure), tool_started: toolStarted },
        }),
      );
      let next: BackgroundAttempt | undefined;
      if (!toolStarted && attemptPlan.decision !== "fits" && attempt.kind !== "fallback") {
        next = fallback;
      } else if (!toolStarted && failureClass === "transient" && attempt.kind === "primary") {
        next = primaryRetry;
      } else if (
        !toolStarted &&
        (failureClass === "transient" || failureClass === "provider_unavailable") &&
        attempt.kind !== "fallback"
      ) {
        next = fallback;
      }

      log.warn("background prompt attempt failed", {
        taskId,
        attempt: attempt.label,
        model: attemptModel.id,
        failureClass,
        toolStarted,
        willRetry: Boolean(next),
        err: failure,
      });

      if (next) {
        attempts.push(next);
        await withLifecycleContext(attemptContext, () =>
          auditLifecycle(next.kind === "fallback" ? "model.fallback" : "model.retry", {
            outcome: "retry",
            provider: next.agentModel.provider,
            model: next.agentModel.id,
            data: { from: attempt.label, to: next.label },
          }),
        );
        if (next.kind === "primary_retry") {
          await waitForRetry(PRIMARY_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * 250), run.signal);
        }
        continue;
      }

      // Keep the failed attempt when it crossed the tool boundary (or cannot
      // be retried) so a later worker does not forget what already happened.
      await persistBackgroundMessages(lifecycle, taskId, newMessages, true);
      throw lastError;
    }

    throw lastError ?? new Error("background prompt exhausted retries");
  } catch (err) {
    const cancelled = run.signal.aborted || isAgentRunAbortError(err);
    await withLifecycleContext(lifecycle, () =>
      auditLifecycle("turn.finished", {
        outcome: cancelled ? "cancelled" : "error",
        data: { error: payloadDescriptor(err instanceof Error ? err.message : err) },
      }),
    );
    if (cancelled) throw new AgentRunAbortError(run.abortReason);
    throw err;
  } finally {
    run.finish();
  }
}
