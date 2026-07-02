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

import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type ImageContent } from "@mariozechner/pi-ai";
import { log } from "../lib/logger.js";
import {
  createTelemetryStreamFn,
  hashTelemetryIdentifier,
  type LlmTelemetryScope,
} from "../observability/llm-telemetry.js";
import { paths } from "../paths.js";
import { getApiKeyForProvider } from "./auth.js";
import { estimateContextTokens, maybeCompact, maybeCompactLoaded } from "./compaction.js";
import {
  appendJobMessages,
  loadJobSession,
  rewriteJobSessionWithCompaction,
  type JobLoadedSession,
} from "./job-session.js";
import { model, resolveModel } from "./model.js";
import { getReasoningLevel } from "./reasoning.js";
import {
  activeAgentRuns,
  AgentRunAbortError,
  isAgentRunAbortError,
  type ActiveAgentRun,
} from "./run-registry.js";
import * as sessions from "./session-manager.js";
import { summarizeArchived } from "./summarizer.js";
import { getSystemPrompt } from "./system-prompt.js";
import { makeAbortableTool } from "./tools/abortable.js";
import { allTools } from "./tools/index.js";

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
const PRIMARY_RETRY_COUNT = 3;
const FALLBACK_PROVIDER = "openrouter";
const FALLBACK_MODEL_ID = "deepseek/deepseek-v4-flash";

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
function buildAgent(messages: AgentMessage[], agentModel = model, telemetryScope?: LlmTelemetryScope): Agent {
  return new Agent({
    initialState: {
      systemPrompt: getSystemPrompt(),
      model: agentModel,
      tools: cancellableTools,
      messages,
      thinkingLevel: getReasoningLevel(),
    },
    getApiKey: getApiKeyForProvider,
    streamFn: telemetryScope ? createTelemetryStreamFn(telemetryScope) : undefined,
    sessionId: telemetryScope?.session_id,
  });
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

async function rewriteScheduledSessionWithCompaction(
  taskId: string,
  entry: { summary: string; tokensBefore: number },
  keptTail: AgentMessage[],
): Promise<void> {
  await rewriteJobSessionWithCompaction(scheduledSessionFile(taskId), entry, keptTail);
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

async function rewriteBackgroundSessionWithCompaction(
  taskId: string,
  entry: { summary: string; tokensBefore: number },
  keptTail: AgentMessage[],
): Promise<void> {
  await rewriteJobSessionWithCompaction(backgroundSessionFile(taskId), entry, keptTail);
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
  const run = activeAgentRuns.start("chat", chatId);
  try {
    ensureNotAborted(run);
    const session = await sessions.resolveSession(chatId);
    ensureNotAborted(run);
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
    ensureNotAborted(run);
    const compaction = await maybeCompact(session.sessionId, loaded, model, makeSummaryMessage, run.signal);
    ensureNotAborted(run);
    if (compaction.didCompact) {
      log.info("compaction applied", {
        chatId,
        sessionId: session.sessionId,
        tokensBefore: compaction.tokensBefore,
      });
    }
    // Ephemeral skill nudge: inject before buildAgent so it enters the agent's
    // context this turn. Never persisted to the session JSONL — recalculated
    // fresh each turn from the actual tool-call count.
    injectSkillNudge(compaction.messages);
    const attempts = [
      ...Array.from({ length: PRIMARY_RETRY_COUNT + 1 }, (_, i) => ({
        label: i === 0 ? "primary" : `primary retry ${i}/${PRIMARY_RETRY_COUNT}`,
        agentModel: model,
      })),
    ];
    if (!isFallbackModelActive()) {
      attempts.push({
        label: `fallback ${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID}`,
        agentModel: resolveModel(FALLBACK_PROVIDER, FALLBACK_MODEL_ID),
      });
    }

    let lastError = "agent message failed";

    const messageTs = new Date().toISOString();

    for (let i = 0; i < attempts.length; i++) {
      ensureNotAborted(run);
      const attempt = attempts[i];
      const agent = buildAgent(compaction.messages.slice(), attempt.agentModel, {
        kind: "chat",
        session_id: session.sessionId,
        chat_id_hash: hashTelemetryIdentifier(chatId),
        attempt_label: attempt.label,
        message_ts: messageTs,
        source_path: join(paths.sessions, `${session.sessionId}.jsonl`),
      });
      const detachAgent = run.attachAgent(agent);
      let currentMsgIsAbandoned = false;
      let promptError: string | undefined;

      const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        if (shouldSuppressForCancelledRun(run)) return;

        const status = formatStatus(event, callbacks.statusMode ?? "off");
        if (status) await callbacks.onStatus?.(status);

        if (shouldSuppressForCancelledRun(run)) return;

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
          if (t && !shouldSuppressForCancelledRun(run)) await callbacks.onAssistantUpdate?.(t);
          return;
        }

        if (event.type === "message_end" && event.message.role === "assistant") {
          const m = event.message;
          if (hasToolCall(m.content)) return;
          if (m.stopReason === "error" || m.stopReason === "aborted") {
            promptError = formatAgentError(m.stopReason, m.errorMessage);
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
          if (t && !shouldSuppressForCancelledRun(run)) await callbacks.onAssistantEnd?.(t);
          return;
        }
      });

      const before = agent.state.messages.length;

      try {
        await agent.prompt(text, images);
        ensureNotAborted(run);
        if (promptError) throw new Error(promptError);

        const newMessages = agent.state.messages.slice(before);
        await sessions.appendMessages(session.sessionId, newMessages);
        await sessions.markActivity(chatId);
        unsubscribe();
        detachAgent();
        return;
      } catch (err) {
        unsubscribe();
        detachAgent();
        if (run.signal.aborted || isAgentRunAbortError(err)) throw new AgentRunAbortError(run.abortReason);
        lastError = err instanceof Error ? err.message : String(err);
        log.warn("agent prompt attempt errored", {
          chatId,
          sessionId: session.sessionId,
          attempt: attempt.label,
          model: `${attempt.agentModel.provider}/${attempt.agentModel.id}`,
          err: lastError,
        });

        const next = attempts[i + 1];
        if (next) {
          if (!shouldSuppressForCancelledRun(run)) {
            await callbacks.onStatus?.(
              next.label.startsWith("fallback") ? "Primary failed; trying fallback model" : "Model call failed; retrying",
            );
          }
          continue;
        }
      }
    }

    if (!shouldSuppressForCancelledRun(run)) {
      await callbacks.onError?.(`Model call failed after retries and fallback: ${lastError}`);
    }
  } catch (err) {
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
  modelOverride: { provider?: string; model?: string } = {},
): Promise<string> {
  const run = activeAgentRuns.start("scheduled", taskId);
  try {
    const taskModel =
      modelOverride.provider && modelOverride.model ? resolveModel(modelOverride.provider, modelOverride.model) : model;
    ensureNotAborted(run);
    const loaded = await loadScheduledMessages(taskId);
    ensureNotAborted(run);
    let initialMessages: AgentMessage[];
    try {
      const compaction = await maybeCompactLoaded(
        `scheduled:${taskId}`,
        loaded,
        taskModel,
        makeSummaryMessage,
        {
          rewriteWithCompaction: (entry, keptTail) => rewriteScheduledSessionWithCompaction(taskId, entry, keptTail),
          reload: () => loadScheduledMessages(taskId),
        },
        run.signal,
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

    const agent = buildAgent(initialMessages, taskModel, {
      kind: "scheduled",
      session_id: `scheduled:${taskId}`,
      task_id: taskId,
      task_name: taskName,
      source_path: scheduledSessionFile(taskId),
      message_ts: new Date().toISOString(),
    });
    const detachAgent = run.attachAgent(agent);
    const before = agent.state.messages.length;
    let finalText = "";
    let errorText = "";

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      if (shouldSuppressForCancelledRun(run)) return;
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (hasToolCall(event.message.content)) return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        errorText = formatAgentError(event.message.stopReason, event.message.errorMessage);
        log.warn("scheduled agent error", {
          taskId,
          stopReason: event.message.stopReason,
          err: event.message.errorMessage ?? "",
        });
        return;
      }
      finalText = extractText(event.message.content).trim();
    });

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

    try {
      ensureNotAborted(run);
      await agent.prompt(taskPrompt);
      ensureNotAborted(run);
    } finally {
      unsubscribe();
      detachAgent();
    }

    await appendScheduledMessages(taskId, agent.state.messages.slice(before));
    if (errorText) throw new Error(errorText);
    if (!finalText) throw new Error("scheduled agent produced no final output");
    return finalText;
  } catch (err) {
    if (run.signal.aborted || isAgentRunAbortError(err)) throw new AgentRunAbortError(run.abortReason);
    throw err;
  } finally {
    run.finish();
  }
}

export async function runBackgroundPrompt(
  taskId: string,
  taskName: string,
  prompt: string,
  taskNotePath: string,
): Promise<string> {
  const run = activeAgentRuns.start("background", taskId);
  try {
    ensureNotAborted(run);
    const loaded = await loadBackgroundMessages(taskId);
    ensureNotAborted(run);
    let initialMessages: AgentMessage[];
    try {
      const compaction = await maybeCompactLoaded(
        `background:${taskId}`,
        loaded,
        model,
        makeSummaryMessage,
        {
          rewriteWithCompaction: (entry, keptTail) => rewriteBackgroundSessionWithCompaction(taskId, entry, keptTail),
          reload: () => loadBackgroundMessages(taskId),
        },
        run.signal,
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

    const agent = buildAgent(initialMessages, model, {
      kind: "background",
      session_id: `background:${taskId}`,
      task_id: taskId,
      task_name: taskName,
      source_path: backgroundSessionFile(taskId),
      message_ts: new Date().toISOString(),
    });
    const detachAgent = run.attachAgent(agent);
    const before = agent.state.messages.length;
    let finalText = "";
    let errorText = "";

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      if (shouldSuppressForCancelledRun(run)) return;
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      if (hasToolCall(event.message.content)) return;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
        errorText = formatAgentError(event.message.stopReason, event.message.errorMessage);
        log.warn("background agent error", {
          taskId,
          stopReason: event.message.stopReason,
          err: event.message.errorMessage ?? "",
        });
        return;
      }
      finalText = extractText(event.message.content).trim();
    });

    const taskPrompt = [
      "You are running as a background JARVIS worker.",
      "You have one long-running task. Work autonomously, but do not make product/security/destructive decisions by guessing.",
      "If blocked, write a question to the task mailbox, set the task status to waiting_on_main in its task JSON, and stop.",
      "If finished, update the task note and task JSON with status awaiting_review. Do not push, merge, deploy, or edit the main checkout unless explicitly instructed.",
      "Use the assigned git worktree for repo changes.",
      "Your final response is a concise handoff summary for main JARVIS.",
      "",
      `Task: ${taskName} (${taskId})`,
      `Task note: ${taskNotePath}`,
      "",
      prompt,
    ].join("\n");

    try {
      ensureNotAborted(run);
      await agent.prompt(taskPrompt);
      ensureNotAborted(run);
    } finally {
      unsubscribe();
      detachAgent();
    }

    await appendBackgroundMessages(taskId, agent.state.messages.slice(before));
    if (errorText) throw new Error(errorText);
    if (!finalText) throw new Error("background agent produced no final output");
    return finalText;
  } catch (err) {
    if (run.signal.aborted || isAgentRunAbortError(err)) throw new AgentRunAbortError(run.abortReason);
    throw err;
  } finally {
    run.finish();
  }
}
