// `bash` tool — the universal escape hatch (DESIGN.md §5).
//
// Runs a command via `/bin/bash -c`, captures stdout+stderr together, and
// returns them with the exit code. Honors the agent's abort signal and a
// per-call timeout (defaulting to config.tools.bash.default_timeout_seconds,
// capped at config.tools.bash.max_timeout_seconds).
//
// Compared to pi-coding-agent's bash tool, this is intentionally minimal:
// no shell prefix and no pluggable spawn hook. The child shell is spawned as
// its own process group so cancellation/timeouts can terminate descendants
// instead of only killing `/bin/bash` and orphaning grandchildren.
//
// Output is clipped to MAX_OUTPUT_BYTES with a head/tail preserved — the same
// pattern as the audit logger's truncate(). Trailing exit-status info stays
// visible even on huge outputs.

import { spawn } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { config } from "../../config.js";
import { auditToolCall } from "../../lib/logger.js";

const schema = Type.Object({
  command: Type.String({ description: "Bash command to run. Has full shell access." }),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds. Defaults to config.tools.bash.default_timeout_seconds.",
    }),
  ),
});

// 100KB is enough to see typical command output without flooding the model
// context. Tools that produce more than this should be re-run with `| head`,
// `| tail`, or redirection to a file the model can read later.
const MAX_OUTPUT_BYTES = 100_000;

function clipOutput(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.byteLength <= MAX_OUTPUT_BYTES) {
    return { text: buf.toString("utf-8"), truncated: false };
  }
  const half = Math.floor(MAX_OUTPUT_BYTES / 2);
  const head = buf.subarray(0, half).toString("utf-8");
  const tail = buf.subarray(buf.byteLength - half).toString("utf-8");
  return {
    text: `${head}\n...[truncated ${buf.byteLength - MAX_OUTPUT_BYTES} bytes]...\n${tail}`,
    truncated: true,
  };
}

export const bashTool: AgentTool<typeof schema> = {
  name: "bash",
  label: "bash",
  description:
    "Run a shell command on the host. You have sudo. Captures stdout+stderr together and returns them with the exit code. Default timeout is set in config; pass `timeout` (seconds) to override.",
  parameters: schema,
  async execute(_id, { command, timeout }: Static<typeof schema>, signal) {
    const t0 = Date.now();

    // Honor the cap from config so the model can't request an unbounded run.
    const timeoutSec = Math.min(
      timeout ?? config.tools.bash.default_timeout_seconds,
      config.tools.bash.max_timeout_seconds,
    );

    return new Promise((resolve, reject) => {
      // Pre-flight: if we were aborted before even starting, bail.
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const child = spawn("/bin/bash", ["-c", command], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Buffer chunks rather than concatenating each time — Buffer.concat at
      // the end is O(N) total instead of O(N²) appends.
      const chunks: Buffer[] = [];
      let timedOut = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const clearForceKillTimer = (): void => {
        if (!forceKillTimer) return;
        clearTimeout(forceKillTimer);
        forceKillTimer = undefined;
      };

      const killProcessGroup = (signalName: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signalName);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            try {
              child.kill(signalName);
            } catch {
              // best effort
            }
          }
        }
      };

      const scheduleForceKill = (): void => {
        if (forceKillTimer) return;
        forceKillTimer = setTimeout(() => {
          forceKillTimer = undefined;
          killProcessGroup("SIGKILL");
        }, 1000);
        forceKillTimer.unref();
      };

      child.stdout.on("data", (b: Buffer) => chunks.push(b));
      child.stderr.on("data", (b: Buffer) => chunks.push(b));

      // SIGTERM first, then SIGKILL after a grace period if the process
      // ignores SIGTERM. unref() so the kill timer doesn't keep Node alive
      // by itself if everything else is shutting down.
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup("SIGTERM");
        scheduleForceKill();
      }, timeoutSec * 1000);

      const onAbort = () => {
        killProcessGroup("SIGTERM");
        scheduleForceKill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", async (code) => {
        clearTimeout(timer);
        clearForceKillTimer();
        signal?.removeEventListener("abort", onAbort);

        const combined = Buffer.concat(chunks);
        const { text, truncated } = clipOutput(combined);
        // -1 is a sentinel for "process exited via signal, no exit code".
        const exit = code ?? -1;
        const status = timedOut ? `timed out after ${timeoutSec}s` : `exit ${exit}`;
        const out = text || "(no output)";

        await auditToolCall({
          tool: "bash",
          args: { command, timeout: timeoutSec },
          // Only outcome=ok if the process actually finished cleanly with 0.
          outcome: timedOut ? "error" : exit === 0 ? "ok" : "error",
          exit,
          duration_ms: Date.now() - t0,
          ...(timedOut ? { error: "timeout" } : {}),
        });

        // If the agent aborted us mid-flight, surface that as a rejection
        // so the agent loop sees a tool error rather than partial output.
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }

        resolve({
          content: [
            {
              type: "text",
              text: `$ ${command}\n${out}\n[${status}${truncated ? "; output truncated" : ""}]`,
            },
          ],
          details: { exit, timedOut, truncated },
        });
      });

      // Spawn-level errors (e.g. /bin/bash missing). Rare but worth distinct
      // handling so they don't get silently swallowed by the close path.
      child.on("error", async (err) => {
        clearTimeout(timer);
        clearForceKillTimer();
        signal?.removeEventListener("abort", onAbort);
        await auditToolCall({
          tool: "bash",
          args: { command, timeout: timeoutSec },
          outcome: "error",
          duration_ms: Date.now() - t0,
          error: err.message,
        });
        reject(err);
      });
    });
  },
};
