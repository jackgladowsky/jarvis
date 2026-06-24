import { openUrlInWorkbench, runStepsInWorkbench } from "./controller.js";
import { renderWorkbenchResult } from "./render.js";

const target = process.argv.find((arg, index) => index >= 2 && arg !== "--");

const fixtureHtml = `<!doctype html>
<html>
  <head><title>Workbench smoke fixture</title></head>
  <body>
    <h1>Workbench smoke fixture</h1>
    <a href="#clicked">Benign details link</a>
    <label for="notes">Notes</label>
    <input id="notes" name="notes" type="text" />
    <p id="clicked">Not clicked yet</p>
    <script>
      document.querySelector('a').addEventListener('click', () => {
        document.querySelector('#clicked').textContent = 'Benign link clicked';
      });
    </script>
  </body>
</html>`;

const run = target
  ? openUrlInWorkbench(target)
  : runStepsInWorkbench(
      [
        { action: "click", text: "Benign details link" },
        { action: "fill", selector: "#notes", value: "non-secret smoke text" },
      ],
      { fixtureHtml, request: "Smoke test: click benign link and type non-secret sample text into a local fixture." },
    );

run
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
