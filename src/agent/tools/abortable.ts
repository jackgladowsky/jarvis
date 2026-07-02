import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "typebox";

export function makeAbortableTool<TParameters extends TSchema>(tool: AgentTool<TParameters>): AgentTool<TParameters> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      if (!signal) return tool.execute(toolCallId, params, signal, onUpdate);
      if (signal.aborted) throw new Error("aborted");

      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(new Error("aborted"));
        signal.addEventListener("abort", abortListener, { once: true });
      });

      try {
        return await Promise.race([tool.execute(toolCallId, params, signal, onUpdate), aborted]);
      } finally {
        if (abortListener) signal.removeEventListener("abort", abortListener);
      }
    },
  };
}
