import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import { config } from "../config.js";

const TEXT_CHARS_PER_TOKEN = 3;
const MESSAGE_OVERHEAD_TOKENS = 8;
export const ABSOLUTE_TOOL_RESULT_BYTES = 64 * 1024;
export const MIN_USEFUL_TOOL_RESULT_TOKENS = 128;

export interface ContextBudgetBreakdown {
  system: number;
  tools: number;
  history: number;
  currentInput: number;
  images: number;
  framing: number;
  totalInput: number;
  outputReserve: number;
  toolLoopReserve: number;
  inputCeiling: number;
  remainingInput: number;
}

export interface ContextPlan {
  decision: "fits" | "compact" | "impossible";
  model: string;
  contextWindow: number;
  breakdown: ContextBudgetBreakdown;
  maxToolResultTokens: number;
  maxToolResultBytes: number;
  reason?: string;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / TEXT_CHARS_PER_TOKEN);
}

function imageBytes(image: ImageContent): number {
  return Math.floor((image.data.length * 3) / 4);
}

/** Conservative provider-aware estimate when pixel dimensions are unavailable. */
export function estimateImageTokens(image: ImageContent, model: Pick<Model<any>, "provider" | "api">): number {
  const bytes = imageBytes(image);
  const byteComponent = Math.ceil(bytes / 700);
  const floor = model.provider === "anthropic" || String(model.api).includes("anthropic") ? 1_600 : 1_100;
  return Math.min(8_192, Math.max(floor, byteComponent));
}

export function estimateMessageTokens(message: AgentMessage, model?: Pick<Model<any>, "provider" | "api">): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  const envelope = message as unknown as Record<string, unknown>;
  // Provider converters replay these identifiers outside `content`.
  for (const key of ["toolCallId", "toolName", "responseId", "responseModel", "errorMessage"]) {
    if (typeof envelope[key] === "string") tokens += estimateTextTokens(envelope[key]);
  }
  const content = envelope.content;
  if (typeof content === "string") return tokens + estimateTextTokens(content);
  if (!Array.isArray(content)) return tokens;
  for (const raw of content as Array<Record<string, unknown>>) {
    if (raw.type === "text" && typeof raw.text === "string") {
      tokens += estimateTextTokens(raw.text);
      if (typeof raw.textSignature === "string") tokens += estimateTextTokens(raw.textSignature);
    } else if (raw.type === "thinking") {
      if (typeof raw.thinking === "string") tokens += estimateTextTokens(raw.thinking);
      // Redacted reasoning is commonly replayed as a large opaque encrypted
      // signature. It consumes provider input even though it is not visible.
      if (typeof raw.thinkingSignature === "string") tokens += estimateTextTokens(raw.thinkingSignature);
    } else if (raw.type === "toolCall") {
      tokens += estimateTextTokens(String(raw.id ?? "") + String(raw.name ?? "") + JSON.stringify(raw.arguments ?? {}));
      if (typeof raw.thoughtSignature === "string") tokens += estimateTextTokens(raw.thoughtSignature);
    } else if (raw.type === "image") {
      const image = raw as unknown as ImageContent;
      tokens += model ? estimateImageTokens(image, model) : 1_600;
    }
  }
  return tokens;
}

export function estimateMessagesTokens(messages: AgentMessage[], model?: Pick<Model<any>, "provider" | "api">): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message, model), 0);
}

export function estimateToolSchemaTokens(tools: AgentTool<any>[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum +
      16 +
      estimateTextTokens(
        JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }),
      ),
    0,
  );
}

function reserves(model: Model<any>): { outputReserve: number; toolLoopReserve: number } {
  const window = Math.max(0, model.contextWindow || 0);
  const modelMax = Math.max(1, model.maxTokens || config.compaction.reserve_tokens);
  const outputReserve = Math.max(1, Math.min(config.compaction.reserve_tokens, modelMax, Math.floor(window / 3)));
  const toolLoopReserve = Math.max(512, Math.min(4_096, Math.floor(window / 16)));
  return { outputReserve, toolLoopReserve };
}

export interface PlanContextInput {
  model: Model<any>;
  systemPrompt: string;
  tools: AgentTool<any>[];
  history: AgentMessage[];
  currentText?: string;
  currentImages?: ImageContent[];
}

export function planContext(input: PlanContextInput): ContextPlan {
  const { model } = input;
  const contextWindow = Math.max(0, model.contextWindow || 0);
  const system = estimateTextTokens(input.systemPrompt);
  const tools = estimateToolSchemaTokens(input.tools);
  const history = estimateMessagesTokens(input.history, model);
  const currentInput = input.currentText ? estimateTextTokens(input.currentText) + MESSAGE_OVERHEAD_TOKENS : 0;
  const images = (input.currentImages ?? []).reduce((sum, image) => sum + estimateImageTokens(image, model), 0);
  const framing = 32;
  const totalInput = system + tools + history + currentInput + images + framing;
  const { outputReserve, toolLoopReserve } = reserves(model);
  const inputCeiling = Math.max(0, contextWindow - outputReserve - toolLoopReserve);
  const remainingInput = inputCeiling - totalInput;
  const fixed = system + tools + currentInput + images + framing;
  const decision =
    contextWindow <= 0 || fixed > inputCeiling ? "impossible" : totalInput > inputCeiling ? "compact" : "fits";
  const maxToolResultTokens = Math.max(0, remainingInput);
  const maxToolResultBytes = Math.max(
    0,
    Math.min(ABSOLUTE_TOOL_RESULT_BYTES, maxToolResultTokens * TEXT_CHARS_PER_TOKEN),
  );
  return {
    decision,
    model: `${model.provider}/${model.id}`,
    contextWindow,
    breakdown: {
      system,
      tools,
      history,
      currentInput,
      images,
      framing,
      totalInput,
      outputReserve,
      toolLoopReserve,
      inputCeiling,
      remainingInput,
    },
    maxToolResultTokens,
    maxToolResultBytes,
    ...(decision === "impossible"
      ? { reason: `fixed request envelope (${fixed} tokens) exceeds input ceiling (${inputCeiling})` }
      : decision === "compact"
        ? { reason: `request requires ${totalInput} input tokens; ceiling is ${inputCeiling}` }
        : {}),
  };
}
