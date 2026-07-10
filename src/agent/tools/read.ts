// `read` tool — one of the four locked-in tools (DESIGN.md §5).
//
// Reads a UTF-8 text file and returns its contents. Supports `offset`/`limit`
// for partial reads of large files, with a continuation hint in the suffix
// so the model knows how to keep going.
//
// Image reading (jpg/png/etc.) is intentionally NOT supported in v1 —
// pi-coding-agent has it but JARVIS via Telegram doesn't need it yet. Add
// later if a real use case shows up.

import { readFile } from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall } from "../../lib/logger.js";

const schema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to read.", minLength: 1 }),
  offset: Type.Optional(Type.Integer({ description: "1-indexed line to start at.", minimum: 1 })),
  limit: Type.Optional(Type.Integer({ description: "Max number of lines to return.", minimum: 1, maximum: 10_000 })),
});

export const readTool: AgentTool<typeof schema> = {
  name: "read",
  label: "read",
  description:
    "Read the contents of a UTF-8 text file. Use offset/limit for large files. Continue with offset until complete.",
  parameters: schema,
  async execute(_id, { path, offset, limit }: Static<typeof schema>) {
    const t0 = Date.now();
    try {
      const buf = await readFile(path);
      const text = buf.toString("utf-8");
      const lines = text.split("\n");

      // Convert 1-indexed offset to 0-indexed array access. Default to 0.
      const start = offset ? Math.max(0, offset - 1) : 0;
      if (start >= lines.length) {
        throw new Error(`offset ${offset} is past end of file (${lines.length} lines)`);
      }

      const end = limit !== undefined ? Math.min(start + limit, lines.length) : lines.length;
      const slice = lines.slice(start, end).join("\n");

      // If we're not at EOF, include a continuation hint so the model knows
      // exactly which offset to use for the next read. Saves a round-trip.
      const remaining = lines.length - end;
      const suffix =
        remaining > 0 ? `\n\n[showing ${start + 1}-${end} of ${lines.length}; offset=${end + 1} for more]` : "";

      // Audit log records what was read but NOT the contents — just byte count
      // (DESIGN.md §13 "read/write content: logged as path + byte count, not
      // contents"). The contents are still on disk if you want to see them.
      await auditToolCall({
        tool: "read",
        args: { path, offset, limit },
        outcome: "ok",
        bytes: buf.byteLength,
        duration_ms: Date.now() - t0,
      });

      return {
        content: [{ type: "text", text: slice + suffix }],
        details: { bytes: buf.byteLength, totalLines: lines.length },
      };
    } catch (err) {
      await auditToolCall({
        tool: "read",
        args: { path, offset, limit },
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};
