import { createHash } from "node:crypto";
import type { AfterToolCallContext, AfterToolCallResult } from "@mariozechner/pi-agent-core";
import type { Context, Model, TextContent } from "@mariozechner/pi-ai";
import { MIN_USEFUL_TOOL_RESULT_TOKENS, planContext } from "./context-budget.js";

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const source = Buffer.from(text, "utf-8");
  if (source.byteLength <= maxBytes) return text;
  let end = Math.min(maxBytes, source.byteLength);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf-8");
}

export interface ToolResultBudgetOptions {
  model: Model<any>;
  minimumBytes?: number;
  /** Shared by all results produced by one Agent. */
  batchUsage?: WeakMap<object, number>;
}

/** Runtime backstop applied to every tool result before it enters the next provider request. */
export function budgetToolResult(
  context: AfterToolCallContext,
  options: ToolResultBudgetOptions,
): AfterToolCallResult | undefined {
  const plan = planContext({
    model: options.model,
    systemPrompt: context.context.systemPrompt,
    tools: context.context.tools ?? [],
    history: context.context.messages,
  });
  // pi-agent-core finalizes every result in a multi-tool assistant batch
  // against the same context snapshot. Account for earlier grants by using
  // the assistant message object as the batch identity.
  const batchKey = context.assistantMessage as object;
  const alreadyGranted = options.batchUsage?.get(batchKey) ?? 0;
  const allowance = Math.max(0, plan.maxToolResultBytes - alreadyGranted);
  const textBlocks = context.result.content.filter((item): item is TextContent => item.type === "text");
  const text = textBlocks.map((item) => item.text).join("\n");
  const encoded = Buffer.byteLength(text);
  const imageCount = context.result.content.filter((item) => item.type === "image").length;
  const hash = createHash("sha256").update(text).digest("hex");

  if (encoded <= allowance && imageCount === 0) {
    options.batchUsage?.set(batchKey, alreadyGranted + encoded);
    return undefined;
  }

  if (allowance < (options.minimumBytes ?? MIN_USEFUL_TOOL_RESULT_TOKENS * 3)) {
    const omitted = `[tool result omitted: context budget exhausted; ${encoded} UTF-8 bytes, sha256=${hash}. Produce a useful response without another tool call.]`;
    // This marker is paid from reserved tool-loop headroom. Do not terminate:
    // pi-agent-core would otherwise stop before the model can give the user a
    // final answer. The Agent-level budgeter disables tools for that one
    // continuation instead.
    options.batchUsage?.set(batchKey, plan.maxToolResultBytes);
    return {
      content: [{ type: "text", text: omitted }],
      details: {
        ...(context.result.details && typeof context.result.details === "object"
          ? (context.result.details as Record<string, unknown>)
          : {}),
        contextTruncated: true,
        contextBudgetExhausted: true,
        originalBytes: encoded,
        sha256: hash,
        omittedImages: imageCount,
      },
    };
  }

  const marker = `\n\n[tool result truncated by context budget: ${encoded} UTF-8 bytes, sha256=${hash}; refine the request or use a continuation cursor]`;
  const prefix = utf8Prefix(text, Math.max(0, allowance - Buffer.byteLength(marker)));
  const returned = prefix + marker;
  options.batchUsage?.set(batchKey, alreadyGranted + Buffer.byteLength(returned));
  return {
    content: [{ type: "text", text: returned }],
    details: {
      ...(context.result.details && typeof context.result.details === "object"
        ? (context.result.details as Record<string, unknown>)
        : {}),
      contextTruncated: true,
      originalBytes: encoded,
      returnedBytes: Buffer.byteLength(returned),
      sha256: hash,
      omittedImages: imageCount,
    },
  };
}

export interface ToolResultBudgeter {
  (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined>;
  /** Remove tool schemas after exhaustion so the required continuation must answer. */
  constrainProviderContext(context: Context): Context;
}

/** One budgeter per Agent so same-batch grants are cumulative. */
export function createToolResultBudgeter(model: Model<any>): ToolResultBudgeter {
  const batchUsage = new WeakMap<object, number>();
  let exhausted = false;
  const budgeter = async (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const result = budgetToolResult(context, { model, batchUsage });
    if (
      result?.details &&
      typeof result.details === "object" &&
      (result.details as Record<string, unknown>).contextBudgetExhausted === true
    ) {
      exhausted = true;
    }
    return result;
  };
  budgeter.constrainProviderContext = (context: Context): Context =>
    exhausted && context.tools?.length ? { ...context, tools: [] } : context;
  return budgeter;
}
