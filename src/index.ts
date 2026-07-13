// Process entrypoint. Glues the agent runtime into the Telegram transport
// and runs until SIGINT/SIGTERM. systemd handles auto-restart in production
// (DESIGN.md §13) — this file's job is clean startup/shutdown and a clear
// error exit.

import { abortAllActiveRuns, handleMessage, waitForActiveRuns } from "./agent/runtime.js";
import * as sessions from "./agent/session-manager.js";
import { model } from "./agent/model.js";
import { resumeUnsummarizedArchives } from "./agent/summarizer.js";
import { startBackgroundWorkerSupervisor } from "./background/supervisor.js";
import { startPrCiWatcher } from "./pr-ci/service.js";
import { notifyPendingConfigRestart } from "./control/restart.js";
import { notifyPendingDeployComplete } from "./lib/deploy-notify.js";
import { log } from "./lib/logger.js";
import { collectVersionInfo, formatVersionInfo } from "./lib/version.js";
import { startScheduler } from "./scheduler.js";
import { runTelegram } from "./transport/telegram.js";

const ACTIVE_RUN_SHUTDOWN_WAIT_MS = 8_000;

async function main(): Promise<void> {
  log.info("jarvis starting", { version: formatVersionInfo(collectVersionInfo()) });
  // Load active.json and create session dirs before any messages can arrive.
  // Crash recovery (replaying transcripts) happens lazily inside handleMessage.
  await sessions.init();
  const shutdownController = new AbortController();
  let shuttingDown = false;

  const stopScheduler = await startScheduler();
  const stopBackgroundSupervisor = await startBackgroundWorkerSupervisor();
  const stopPrCiWatcher = await startPrCiWatcher();

  const beginShutdown = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown requested", { sig });
    shutdownController.abort(new Error(`shutdown: ${sig}`));
    stopScheduler();
    stopBackgroundSupervisor();
    stopPrCiWatcher();
    const aborted = abortAllActiveRuns(`Shutdown requested (${sig}).`);
    log.info("active agent runs aborted", { aborted });
  };

  process.once("SIGINT", beginShutdown);
  process.once("SIGTERM", beginShutdown);

  try {
    await runTelegram(handleMessage, {
      signal: shutdownController.signal,
      onStarted: async () => {
        await notifyPendingConfigRestart().catch((err) =>
          log.warn("config restart notification failed", { err: err instanceof Error ? err.message : err }),
        );
        await notifyPendingDeployComplete().catch((err) =>
          log.warn("deploy readiness notification failed", { err: err instanceof Error ? err.message : err }),
        );
        void resumeUnsummarizedArchives(model).catch((err) =>
          log.warn("session-summary recovery failed", { err: err instanceof Error ? err.message : err }),
        );
      },
    });
  } finally {
    shutdownController.abort(new Error("telegram stopped"));
    stopScheduler();
    stopBackgroundSupervisor();
    stopPrCiWatcher();
    abortAllActiveRuns("Process exiting.");
    const drainedRuns = await waitForActiveRuns(ACTIVE_RUN_SHUTDOWN_WAIT_MS);
    if (!drainedRuns) log.warn("timed out waiting for active agent runs to stop");
    process.removeListener("SIGINT", beginShutdown);
    process.removeListener("SIGTERM", beginShutdown);
  }
  log.info("jarvis exited cleanly");
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
