// Process entrypoint. Glues the agent runtime into the Telegram transport
// and runs until SIGINT/SIGTERM. systemd handles auto-restart in production
// (DESIGN.md §13) — this file's job is just clean startup and a clear error
// exit.

import { handleMessage } from "./agent/runtime.js";
import { log } from "./lib/logger.js";
import { runTelegram } from "./transport/telegram.js";

async function main(): Promise<void> {
  log.info("jarvis starting");
  // runTelegram only resolves once the bot is stopped (via SIGINT/SIGTERM
  // handlers in transport/telegram.ts).
  await runTelegram(handleMessage);
  log.info("jarvis exited cleanly");
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
