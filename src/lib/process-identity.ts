import { readFile } from "node:fs/promises";

/** Parse Linux /proc/<pid>/stat field 22 without being fooled by spaces in comm. */
export function parseLinuxProcessStartTime(statLine: string): string | undefined {
  const closeParen = statLine.lastIndexOf(")");
  if (closeParen < 0) return undefined;
  // The suffix begins at field 3 (state); starttime is field 22, index 19.
  const fields = statLine
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    // `/proc/self` remains correct in runtimes where the PID exposed to Node
    // is namespace-translated differently from the procfs mount.
    const statPath = pid === process.pid ? "/proc/self/stat" : `/proc/${pid}/stat`;
    return parseLinuxProcessStartTime(await readFile(statPath, "utf-8"));
  } catch {
    return undefined;
  }
}
