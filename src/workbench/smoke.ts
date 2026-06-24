import { openUrlInWorkbench } from "./controller.js";
import { renderWorkbenchResult } from "./render.js";

const target = process.argv.find((arg, index) => index >= 2 && arg !== "--") ?? "https://example.com";

openUrlInWorkbench(target)
  .then((snapshot) => {
    console.log(renderWorkbenchResult(snapshot));
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|browserType\.launchPersistentContext/i.test(message)) {
      console.error(`${message}\n\nInstall the local browser binary with: pnpm exec playwright install chromium`);
    } else {
      console.error(message);
    }
    process.exit(1);
  });
