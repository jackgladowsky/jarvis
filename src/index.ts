import { handleMessage } from "./agent/runtime.js";
import { log } from "./lib/logger.js";
import { runTelegram } from "./transport/telegram.js";

async function main(): Promise<void> {
  log.info("jarvis starting");
  await runTelegram(handleMessage);
  log.info("jarvis exited cleanly");
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
