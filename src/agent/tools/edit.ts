// `edit` tool — one of the four locked-in tools (DESIGN.md §5).
//
// Surgical single-string-replace edit. The `oldText` must appear EXACTLY ONCE
// in the file — if it appears 0 times we error (target doesn't exist), if it
// appears 2+ times we error (ambiguous; the model needs to add context).
//
// pi-coding-agent supports a batched array of edits per call. JARVIS sticks
// with single-edit for v1 because the conversational/Telegram workflow tends
// to be one tweak at a time. The system prompt in Appendix A reflects this.

import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall } from "../../lib/logger.js";

const schema = Type.Object({
  path: Type.String({ description: "Path to the file to edit." }),
  oldText: Type.String({
    description: "Exact substring to replace. Must appear exactly once in the file.",
  }),
  newText: Type.String({ description: "Replacement text." }),
});

export const editTool: AgentTool<typeof schema> = {
  name: "edit",
  label: "edit",
  description:
    "Replace one occurrence of an exact substring in a file. The oldText must match exactly once — include enough surrounding context to make it unique.",
  parameters: schema,
  async execute(_id, { path, oldText, newText }: Static<typeof schema>) {
    const t0 = Date.now();
    try {
      const original = await readFile(path, "utf-8");

      // Find the first occurrence; if none, the model is editing a target
      // that doesn't exist (probably a stale read or a typo).
      const first = original.indexOf(oldText);
      if (first === -1) {
        throw new Error(`oldText not found in ${path}`);
      }
      // Look for a second occurrence. If found, the edit is ambiguous —
      // force the model to add surrounding context rather than guess which
      // hit was intended.
      const second = original.indexOf(oldText, first + 1);
      if (second !== -1) {
        throw new Error(`oldText appears multiple times in ${path}; include more surrounding context so it's unique`);
      }

      const updated = original.slice(0, first) + newText + original.slice(first + oldText.length);
      await writeFile(path, updated, "utf-8");

      const bytes = Buffer.byteLength(updated, "utf-8");
      await auditToolCall({
        tool: "edit",
        args: { path },
        outcome: "ok",
        bytes,
        duration_ms: Date.now() - t0,
      });

      return {
        content: [{ type: "text", text: `edited ${path} (${bytes} bytes)` }],
        details: { bytes },
      };
    } catch (err) {
      await auditToolCall({
        tool: "edit",
        args: { path },
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};
