// `write` tool — one of the four locked-in tools (DESIGN.md §5).
//
// Creates or overwrites a file with the given contents. Parent directories
// are created on demand so JARVIS doesn't have to mkdir before writing.
// There's no append mode — if the model wants to add to a file, it should
// `read` then `write` (or use `edit` for surgical changes).

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { atomicWriteFile, withFileLock } from "../../lib/durable-file.js";
import { auditToolCall } from "../../lib/logger.js";

const schema = Type.Object({
  path: Type.String({ description: "Path to the file to create or overwrite.", minLength: 1 }),
  content: Type.String({ description: "Full file contents to write (UTF-8)." }),
});

export const writeTool: AgentTool<typeof schema> = {
  name: "write",
  label: "write",
  description:
    "Create or overwrite a file. Parent directories are created as needed. Writes the full contents — there is no append.",
  parameters: schema,
  async execute(_id, { path, content }: Static<typeof schema>) {
    const t0 = Date.now();
    try {
      // Serialize JARVIS writers across processes and replace atomically so a
      // crash can never leave the destination truncated or half-written.
      await withFileLock(path, () => atomicWriteFile(path, content));

      const bytes = Buffer.byteLength(content, "utf-8");
      // Same as `read`: log path + byte count, never contents.
      await auditToolCall({
        tool: "write",
        args: { path },
        outcome: "ok",
        bytes,
        duration_ms: Date.now() - t0,
      });

      return {
        content: [{ type: "text", text: `wrote ${bytes} bytes to ${path}` }],
        details: { bytes },
      };
    } catch (err) {
      await auditToolCall({
        tool: "write",
        args: { path },
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};
