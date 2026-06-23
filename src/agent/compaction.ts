// Context compaction — DESIGN.md §10.
//
// Mirrors pi-coding-agent's algorithm directly:
//   1. Estimate total context tokens for the session's effective messages.
//   2. If `tokens > model.contextWindow - reserve_tokens`, compact:
//      a. Walk backward through the messages-since-last-compaction,
//         accumulating tokens until `keep_recent_tokens` is reached.
//      b. Slide the cut point to the nearest preceding user-message boundary
//         so we never split a turn (avoids orphaned tool calls in the tail).
//      c. LLM-summarize everything before the cut, passing any previous
//         summary as context (the model uses UPDATE_SUMMARIZATION_PROMPT to
//         merge instead of forgetting earlier summaries).
//   3. Persist the new summary as a `compaction` entry in the session JSONL.
//      session-manager.ts's `load` reads the JSONL forward and treats the
//      most recent compaction as "everything before this is now the summary."
//
// Token estimation uses chars/4 — conservative (overestimates), no provider
// round-trip needed. Same heuristic pi uses.

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { completeSimple, type Model } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { getApiKeyForProvider } from "./auth.js";
import * as sessions from "./session-manager.js";
import type { LoadedSession } from "./session-manager.js";

// ─── Token estimation ───────────────────────────────────────────────────────

// Characters per token, conservative side. Real tokenizers vary by model
// (~3.5–4.5 chars/token for English) — picking 4 keeps us safely high.
const CHARS_PER_TOKEN = 4;

function tokensForString(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

// Per-message token estimate. Mirrors pi's `estimateTokens` for the three
// message kinds JARVIS uses (user / assistant / toolResult). Image content
// is approximated at ~1200 tokens — not used in v1 but cheap to keep.
export function estimateMessageTokens(message: AgentMessage): number {
  const role = (message as { role?: string }).role;
  if (role === "user") {
    const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
    if (typeof content === "string") return tokensForString(content);
    let chars = 0;
    for (const block of content) {
      if (block.type === "text" && block.text) chars += block.text.length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  if (role === "assistant") {
    const content = (message as unknown as { content: Array<Record<string, unknown>> }).content;
    let chars = 0;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        chars += block.text.length;
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        chars += block.thinking.length;
      } else if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "";
        chars += name.length + JSON.stringify(block.arguments ?? {}).length;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  if (role === "toolResult") {
    const content = (
      message as {
        content: string | Array<{ type: string; text?: string }>;
      }
    ).content;
    if (typeof content === "string") return tokensForString(content);
    let chars = 0;
    for (const block of content) {
      if (block.type === "text" && block.text) chars += block.text.length;
      else if (block.type === "image") chars += 4800; // ~1200 tokens
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  return 0;
}

export function estimateContextTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ─── Trigger ────────────────────────────────────────────────────────────────

export function shouldCompact(contextTokens: number, contextWindow: number): boolean {
  if (!config.compaction.enabled) return false;
  if (contextWindow <= 0) return false; // model didn't expose a window
  return contextTokens > contextWindow - config.compaction.reserve_tokens;
}

// ─── Cut point ──────────────────────────────────────────────────────────────

// Walk backward through `messages` accumulating tokens. Once we have at
// least `keepRecentTokens` worth of recent context, slide further back to
// the nearest preceding user-message boundary so the kept tail starts at a
// clean turn.
//
// Returns the index of the first message to KEEP. Anything at index < cut
// goes into the summary.
export function findCutPoint(messages: AgentMessage[], keepRecentTokens: number): number {
  if (messages.length === 0) return 0;

  let accum = 0;
  let cut = messages.length; // start past the end; walk backward
  for (let i = messages.length - 1; i >= 0; i--) {
    accum += estimateMessageTokens(messages[i]);
    if (accum >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  // If we never reached the threshold, everything is "recent" — nothing to
  // compact.
  if (accum < keepRecentTokens) return 0;

  // Slide back to a user-message boundary. We never split a turn — keeping
  // the kept tail anchored at a user message avoids leaving orphaned tool
  // results or assistant tool calls dangling at the head of the tail.
  while (cut > 0 && (messages[cut] as { role?: string }).role !== "user") {
    cut--;
  }
  return cut;
}

// ─── Summarization ──────────────────────────────────────────────────────────

// Lifted from pi-coding-agent. The structured format gives the model a
// predictable shape to fill in and makes UPDATE summarization (merging in
// new content) reliable.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const INITIAL_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the same exact format as the previous summary. Keep each section concise.`;

// Simple text serialization of messages for the summarizer's prompt. We
// don't need pi's full convertToLlm machinery — just enough for the model
// to read the conversation linearly.
function serializeForSummary(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = (m as { role?: string }).role;
    if (role === "user") {
      const c = (m as { content: string | Array<{ type: string; text?: string }> }).content;
      const text =
        typeof c === "string"
          ? c
          : c
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n");
      parts.push(`USER: ${text}`);
    } else if (role === "assistant") {
      const blocks = (m as unknown as { content: Array<Record<string, unknown>> }).content;
      const lines: string[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") lines.push(b.text);
        else if (b.type === "toolCall") {
          lines.push(`[tool: ${b.name} ${JSON.stringify(b.arguments ?? {})}]`);
        }
      }
      parts.push(`ASSISTANT: ${lines.join("\n")}`);
    } else if (role === "toolResult") {
      const c = (m as { content: string | Array<{ type: string; text?: string }> }).content;
      const text =
        typeof c === "string"
          ? c
          : c
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n");
      parts.push(`TOOL_RESULT: ${text}`);
    }
  }
  return parts.join("\n\n");
}

async function generateSummary(
  toSummarize: AgentMessage[],
  model: Model<any>,
  previousSummary: string | undefined,
): Promise<string> {
  const conversation = serializeForSummary(toSummarize);
  const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : INITIAL_SUMMARIZATION_PROMPT;
  const prompt = previousSummary
    ? `<conversation>\n${conversation}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${basePrompt}`
    : `<conversation>\n${conversation}\n</conversation>\n\n${basePrompt}`;

  const apiKey = await getApiKeyForProvider(model.provider);
  if (!apiKey) {
    throw new Error(`no api key for provider ${model.provider} (compaction)`);
  }

  const response = await completeSimple(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey,
      // Cap summary output well below reserve_tokens so the next turn has
      // breathing room — pi uses 0.8 of reserve, we follow.
      maxTokens: Math.floor(0.8 * config.compaction.reserve_tokens),
    },
  );

  if (response.stopReason === "error") {
    throw new Error(`summarization failed: ${response.errorMessage ?? "unknown"}`);
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ─── Public entry: maybeCompact ─────────────────────────────────────────────

export interface MaybeCompactResult {
  /** Effective messages to feed the agent for this turn. */
  messages: AgentMessage[];
  /** True if a compaction ran during this call. */
  didCompact: boolean;
  /** Reported tokens BEFORE compaction (for logging/audit). */
  tokensBefore: number;
}

// Called by the runtime before each agent.prompt(). If the session is under
// the threshold this is just a token-count + return; otherwise it runs the
// full compaction pipeline and returns the freshly compacted message list.
export interface CompactionStore {
  appendCompactionEntry?: (entry: { summary: string; tokensBefore: number }) => Promise<void>;
  rewriteWithCompaction?: (entry: { summary: string; tokensBefore: number }, keptTail: AgentMessage[]) => Promise<void>;
  reload: () => Promise<LoadedSession>;
}

export async function maybeCompactLoaded(
  sessionId: string,
  loaded: LoadedSession,
  model: Model<any>,
  makeSummaryMessage: (summary: string) => AgentMessage,
  store: CompactionStore,
): Promise<MaybeCompactResult> {
  // Build the effective list (what the agent would actually see this turn).
  const effective = loaded.previousSummary
    ? [makeSummaryMessage(loaded.previousSummary), ...loaded.tail]
    : loaded.tail.slice();

  const tokens = estimateContextTokens(effective);

  if (!shouldCompact(tokens, model.contextWindow)) {
    return { messages: effective, didCompact: false, tokensBefore: tokens };
  }

  // We're over the threshold. Cut within the tail (never re-summarize the
  // previous summary on its own — UPDATE_SUMMARIZATION_PROMPT handles
  // merging when we pass `previousSummary` to the LLM).
  const cut = findCutPoint(loaded.tail, config.compaction.keep_recent_tokens);
  if (cut === 0) {
    // Nothing to summarize (the entire tail fits within keep_recent_tokens).
    // This can happen if the tail is short but the previous summary is
    // long-lived and itself near the limit. Bail rather than churn.
    log.warn("compaction triggered but cut=0 — nothing to summarize", {
      sessionId,
      tokens,
    });
    return { messages: effective, didCompact: false, tokensBefore: tokens };
  }

  log.info("compacting session", {
    sessionId,
    tokensBefore: tokens,
    contextWindow: model.contextWindow,
    cuttingMessages: cut,
    keepingMessages: loaded.tail.length - cut,
  });

  const toSummarize = loaded.tail.slice(0, cut);
  const newSummary = await generateSummary(toSummarize, model, loaded.previousSummary);

  const entry = {
    summary: newSummary,
    tokensBefore: tokens,
  };

  if (store.rewriteWithCompaction) {
    await store.rewriteWithCompaction(entry, loaded.tail.slice(cut));
  } else if (store.appendCompactionEntry) {
    await store.appendCompactionEntry(entry);
  } else {
    throw new Error("compaction store cannot persist compaction entry");
  }

  // Reload — the JSONL now has the new compaction entry, and `load` will
  // surface it as the new previousSummary with the freshly trimmed tail.
  const reloaded = await store.reload();
  const newEffective = reloaded.previousSummary
    ? [makeSummaryMessage(reloaded.previousSummary), ...reloaded.tail]
    : reloaded.tail.slice();

  return { messages: newEffective, didCompact: true, tokensBefore: tokens };
}

export async function maybeCompact(
  sessionId: string,
  loaded: LoadedSession,
  model: Model<any>,
  makeSummaryMessage: (summary: string) => AgentMessage,
): Promise<MaybeCompactResult> {
  return maybeCompactLoaded(sessionId, loaded, model, makeSummaryMessage, {
    appendCompactionEntry: (entry) => sessions.appendCompactionEntry(sessionId, entry),
    reload: () => sessions.load(sessionId),
  });
}
