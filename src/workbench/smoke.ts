import { openUrlInWorkbench, runStepsInWorkbench } from "./controller.js";
import { renderWorkbenchResult } from "./render.js";

const target = process.argv.find((arg, index) => index >= 2 && arg !== "--");

const fixtureHtml = `<!doctype html>
<html>
  <head><title>Workbench smoke fixture</title></head>
  <body>
    <h1>Workbench smoke fixture</h1>
    <a href="#clicked">Benign details link</a>
    <form>
      <label for="notes">Notes</label>
      <input id="notes" name="notes" type="text" />
      <button id="go" type="submit">Search</button>
    </form>
    <p id="clicked">Not clicked yet</p>
    <script>
      document.querySelector('a').addEventListener('click', () => {
        document.querySelector('#clicked').textContent = 'Benign link clicked';
      });
      document.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        document.querySelector('#clicked').textContent = 'Searched: ' + document.querySelector('#notes').value;
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
        { action: "submit", selector: "#go" },
      ],
      {
        fixtureHtml,
        request:
          "Smoke test: click benign link, type non-secret sample text, and submit a benign local fixture search.",
      },
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
