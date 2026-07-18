// Bounded UTF-8 text reader. It never buffers an entire file and always
// returns a continuation cursor when byte or line limits stop the read.

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall } from "../../lib/logger.js";

const DEFAULT_MAX_OUTPUT_BYTES = 48 * 1024;
const SCAN_CHUNK_BYTES = 32 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

const schema = Type.Object({
  path: Type.String({ description: "Absolute or relative path to the file to read.", minLength: 1 }),
  offset: Type.Optional(Type.Integer({ description: "1-indexed line to start at.", minimum: 1 })),
  limit: Type.Optional(Type.Integer({ description: "Max number of lines to return.", minimum: 1, maximum: 10_000 })),
  cursor: Type.Optional(
    Type.String({ description: "Opaque continuation cursor returned by a previous bounded read." }),
  ),
});

interface ReadCursor {
  byte: number;
  line: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function encodeCursor(cursor: ReadCursor): string {
  return `v2:${Buffer.from(JSON.stringify(cursor)).toString("base64url")}`;
}

function decodeCursor(raw: string): ReadCursor {
  if (!raw.startsWith("v2:")) throw new Error("invalid or legacy read continuation cursor");
  let parsed: Partial<ReadCursor>;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(3), "base64url").toString("utf-8")) as Partial<ReadCursor>;
  } catch {
    throw new Error("invalid read continuation cursor");
  }
  for (const key of ["byte", "line", "dev", "ino", "size", "mtimeMs"] as const) {
    if (typeof parsed[key] !== "number" || !Number.isFinite(parsed[key])) throw new Error("invalid read cursor");
  }
  if (!Number.isSafeInteger(parsed.byte) || !Number.isSafeInteger(parsed.line) || (parsed.line ?? 0) < 1) {
    throw new Error("invalid read cursor");
  }
  return parsed as ReadCursor;
}

function validUtf8PrefixLength(buffer: Buffer): number {
  for (let trim = 0; trim <= Math.min(3, buffer.byteLength); trim += 1) {
    const end = buffer.byteLength - trim;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
      return end;
    } catch {
      // A split multibyte sequence can require up to three bytes of trimming.
    }
  }
  throw new Error("file is not valid UTF-8 text");
}

async function byteForLine(
  handle: Awaited<ReturnType<typeof open>>,
  targetLine: number,
  size: number,
): Promise<number> {
  if (targetLine <= 1) return 0;
  let position = 0;
  let line = 1;
  const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, size - position), position);
    if (bytesRead === 0) break;
    for (let index = 0; index < bytesRead; index += 1) {
      if (chunk[index] === 0x0a) {
        line += 1;
        if (line === targetLine) return position + index + 1;
      }
    }
    position += bytesRead;
  }
  throw new Error(`offset ${targetLine} is past end of file (${line} lines)`);
}

async function probeText(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<void> {
  if (size === 0) return;
  const probe = Buffer.allocUnsafe(Math.min(BINARY_PROBE_BYTES, size));
  const { bytesRead } = await handle.read(probe, 0, probe.byteLength, 0);
  const view = probe.subarray(0, bytesRead);
  if (view.includes(0)) throw new Error("refusing to read binary file (NUL byte detected)");
  // Permit an incomplete final code point in the probe, but reject invalid UTF-8.
  validUtf8PrefixLength(view);
}

export const readTool: AgentTool<typeof schema> = {
  name: "read",
  label: "read",
  description:
    "Read bounded UTF-8 text from a file. Large results are truncated with an explicit continuation cursor; binary files are rejected.",
  parameters: schema,
  async execute(_id, { path, offset, limit, cursor }: Static<typeof schema>) {
    const t0 = Date.now();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (cursor && offset !== undefined) throw new Error("pass either offset or cursor, not both");
      handle = await open(path, "r");
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("read supports regular files only");
      await probeText(handle, stat.size);

      const identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
      const start = cursor
        ? decodeCursor(cursor)
        : { byte: await byteForLine(handle, offset ?? 1, stat.size), line: offset ?? 1, ...identity };
      if (
        cursor &&
        (start.dev !== identity.dev ||
          start.ino !== identity.ino ||
          start.size !== identity.size ||
          start.mtimeMs !== identity.mtimeMs)
      ) {
        throw new Error("stale read continuation cursor: file changed since the previous read");
      }
      if (start.byte > stat.size) throw new Error("read cursor is past end of file");
      const maxLines = limit ?? 1_000;
      const buffers: Buffer[] = [];
      let kept = 0;
      let position = start.byte;
      let currentLine = start.line;
      let linesCompleted = 0;
      let stoppedForLines = false;

      while (position < stat.size && kept < DEFAULT_MAX_OUTPUT_BYTES && !stoppedForLines) {
        const request = Math.min(SCAN_CHUNK_BYTES, stat.size - position, DEFAULT_MAX_OUTPUT_BYTES - kept);
        const chunk = Buffer.allocUnsafe(request);
        const { bytesRead } = await handle.read(chunk, 0, request, position);
        if (bytesRead === 0) break;
        let take = bytesRead;
        for (let index = 0; index < bytesRead; index += 1) {
          if (chunk[index] !== 0x0a) continue;
          linesCompleted += 1;
          currentLine += 1;
          if (linesCompleted >= maxLines) {
            take = index + 1;
            stoppedForLines = true;
            break;
          }
        }
        buffers.push(Buffer.from(chunk.subarray(0, take)));
        kept += take;
        position += take;
      }

      let output = Buffer.concat(buffers, kept);
      const validLength = validUtf8PrefixLength(output);
      if (validLength !== output.byteLength) {
        position -= output.byteLength - validLength;
        output = output.subarray(0, validLength);
      }
      const truncated = position < stat.size;
      const nextCursor = truncated ? encodeCursor({ byte: position, line: currentLine, ...identity }) : undefined;
      const text = output.toString("utf-8");
      const hash = createHash("sha256").update(output).digest("hex");
      const marker = truncated
        ? `\n\n[truncated: returned ${output.byteLength} of ${stat.size - start.byte} remaining bytes; cursor=${nextCursor}]`
        : "";

      await auditToolCall({
        tool: "read",
        args: { path, offset, limit, cursor },
        outcome: "ok",
        bytes: output.byteLength,
        duration_ms: Date.now() - t0,
      });
      return {
        content: [{ type: "text", text: text + marker }],
        details: {
          fileBytes: stat.size,
          returnedBytes: output.byteLength,
          startLine: start.line,
          nextLine: currentLine,
          truncated,
          cursor: nextCursor,
          sha256: hash,
        },
      };
    } catch (err) {
      await auditToolCall({
        tool: "read",
        args: { path, offset, limit, cursor },
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
};
