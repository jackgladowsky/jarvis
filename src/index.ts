// Process entrypoint. Glues the agent runtime into the Telegram transport
// and runs until SIGINT/SIGTERM. systemd handles auto-restart in production
// (DESIGN.md §13) — this file's job is clean startup/shutdown and a clear
// error exit.

import { abortAllActiveRuns, handleMessage, waitForActiveRuns } from "./agent/runtime.js";
import * as sessions from "./agent/session-manager.js";
import { notifyPendingDeployComplete } from "./lib/deploy-notify.js";
import { log } from "./lib/logger.js";
import { collectVersionInfo, formatVersionInfo } from "./lib/version.js";
import { drainLlmTelemetryQueueOnce, startLlmTelemetryDrain } from "./observability/llm-telemetry.js";
import { startScheduler } from "./scheduler.js";
import { runTelegram } from "./transport/telegram.js";

const ACTIVE_RUN_SHUTDOWN_WAIT_MS = 8_000;
const TELEMETRY_SHUTDOWN_DRAIN_LIMIT = 25;

async function main(): Promise<void> {
  log.info("jarvis starting", { version: formatVersionInfo(collectVersionInfo()) });
  // Load active.json and create session dirs before any messages can arrive.
  // Crash recovery (replaying transcripts) happens lazily inside handleMessage.
  await sessions.init();
  await notifyPendingDeployComplete();

  const shutdownController = new AbortController();
  let shuttingDown = false;

  const stopTelemetryDrain = startLlmTelemetryDrain();
  const stopScheduler = await startScheduler();

  const beginShutdown = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown requested", { sig });
    shutdownController.abort(new Error(`shutdown: ${sig}`));
    stopScheduler();
    const aborted = abortAllActiveRuns(`Shutdown requested (${sig}).`);
    log.info("active agent runs aborted", { aborted });
  };

  process.once("SIGINT", beginShutdown);
  process.once("SIGTERM", beginShutdown);

  try {
    await runTelegram(handleMessage, { signal: shutdownController.signal });
  } finally {
    shutdownController.abort(new Error("telegram stopped"));
    stopScheduler();
    abortAllActiveRuns("Process exiting.");
    const drainedRuns = await waitForActiveRuns(ACTIVE_RUN_SHUTDOWN_WAIT_MS);
    if (!drainedRuns) log.warn("timed out waiting for active agent runs to stop");
    stopTelemetryDrain();
    await drainLlmTelemetryQueueOnce(TELEMETRY_SHUTDOWN_DRAIN_LIMIT);
    process.removeListener("SIGINT", beginShutdown);
    process.removeListener("SIGTERM", beginShutdown);
  }
  log.info("jarvis exited cleanly");
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
