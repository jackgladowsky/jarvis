import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { auditToolCall, log, type AuditEntry } from "../../lib/logger.js";

type AuditWriter = (entry: Omit<AuditEntry, "ts" | "args"> & { args: unknown }) => Promise<void>;

export interface ToolAuditOptions<TParameters extends TSchema> {
  /**
   * Return the deliberately-small argument metadata that is safe to persist.
   * In particular, callers must not return file bodies, form values, tokens,
   * or arbitrary MCP argument values here.
   */
  summarizeArgs: (params: Static<TParameters>) => unknown;
  /** Replace arbitrary tool error text when it could echo secret/content values. */
  summarizeError?: (error: unknown, params: Static<TParameters>) => string;
  /** Test seam; production callers use the durable audit writer. */
  audit?: AuditWriter;
}

function errorText(result: unknown): string | undefined {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find(
    (item): item is { type: "text"; text: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  )?.text;
  if (!text) return undefined;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * Add the same durable, failure-isolated audit boundary used by core tools.
 * Apply this only to tools that do not already audit themselves; otherwise a
 * single operation would produce misleading duplicate audit rows.
 */
export function withToolAudit<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
  options: ToolAuditOptions<TParameters>,
): AgentTool<TParameters, TDetails> {
  const writer = options.audit ?? auditToolCall;

  const writeAudit = async (entry: Parameters<AuditWriter>[0]): Promise<void> => {
    try {
      await writer(entry);
    } catch (err) {
      // `auditToolCall` already failure-isolates disk errors. Keep the wrapper
      // safe when a future writer or a test double violates that contract.
      log.error("tool audit writer failed", {
        tool: tool.name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const startedAt = Date.now();
      const args = options.summarizeArgs(params);
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        const isError = (result as { isError?: unknown }).isError === true;
        const encodedError = errorText(result) ?? "tool returned an error result";
        await writeAudit({
          tool: tool.name,
          args,
          outcome: isError ? "error" : "ok",
          duration_ms: Date.now() - startedAt,
          ...(isError ? { error: options.summarizeError?.(new Error(encodedError), params) ?? encodedError } : {}),
        });
        return result;
      } catch (err) {
        await writeAudit({
          tool: tool.name,
          args,
          outcome: "error",
          duration_ms: Date.now() - startedAt,
          error: options.summarizeError?.(err, params) ?? (err instanceof Error ? err.message : String(err)),
        });
        throw err;
      }
    },
  };
}
