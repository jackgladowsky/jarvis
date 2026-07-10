import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile, withFileLock } from "./durable-file.js";

export interface ParsedJsonLines<T> {
  values: T[];
  malformedTrailingLine?: string;
  validPrefix: string;
}

/** Parse JSONL while permitting exactly one malformed final non-empty line. */
export function parseJsonLines<T = unknown>(raw: string): ParsedJsonLines<T> {
  const lines = raw.split("\n");
  let finalNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      finalNonEmpty = index;
      break;
    }
  }

  const values: T[] = [];
  const validLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
      validLines.push(line);
    } catch (err) {
      if (index !== finalNonEmpty) {
        throw new SyntaxError(
          `malformed JSONL at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        values,
        malformedTrailingLine: line,
        validPrefix: validLines.length ? `${validLines.join("\n")}\n` : "",
      };
    }
  }
  return { values, validPrefix: validLines.length ? `${validLines.join("\n")}\n` : "" };
}

/**
 * Read JSONL and repair a crash-truncated final record. The rejected fragment
 * is preserved beside the source before the source is atomically truncated.
 * Interior corruption is never hidden.
 */
export async function readJsonLinesRecovering<T = unknown>(file: string): Promise<T[]> {
  return withFileLock(file, async () => {
    const raw = await readFile(file, "utf-8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    const parsed = parseJsonLines<T>(raw);
    if (parsed.malformedTrailingLine !== undefined) {
      await quarantineTrailingLine(file, parsed.malformedTrailingLine);
      await atomicWriteFile(file, parsed.validPrefix);
    } else if (raw.length > 0 && !raw.endsWith("\n")) {
      // A valid but unterminated final record would concatenate with the next
      // append and turn two valid objects into one corrupt line.
      await atomicWriteFile(file, parsed.validPrefix);
    }
    return parsed.values;
  });
}

async function quarantineTrailingLine(file: string, line: string): Promise<void> {
  const quarantine = `${file}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
  await atomicWriteFile(quarantine, `${line}\n`);
}

/** Append one or more already-serialized JSONL records after repairing the tail. */
export async function appendJsonLinesDurable(file: string, data: string): Promise<void> {
  if (!data) return;
  const incoming = parseJsonLines(data);
  if (incoming.malformedTrailingLine !== undefined) throw new SyntaxError("cannot append malformed JSONL data");
  if (!incoming.validPrefix) return;
  await withFileLock(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const raw = await readFile(file, "utf-8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    const parsed = parseJsonLines(raw);
    if (parsed.malformedTrailingLine !== undefined) {
      await quarantineTrailingLine(file, parsed.malformedTrailingLine);
      await atomicWriteFile(file, parsed.validPrefix);
    } else if (raw.length > 0 && !raw.endsWith("\n")) {
      await atomicWriteFile(file, parsed.validPrefix);
    }

    const handle = await open(file, "a", 0o600);
    try {
      await handle.writeFile(incoming.validPrefix);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
