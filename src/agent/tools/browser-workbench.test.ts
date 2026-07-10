import test from "node:test";
import assert from "node:assert/strict";
import { allTools } from "./index.js";
import { browserWorkbenchTool } from "./browser-workbench.js";

test("browser_workbench tool is available for natural-language agent routing", () => {
  assert.equal(browserWorkbenchTool.name, "browser_workbench");
  assert.ok(allTools.some((tool) => tool.name === "browser_workbench"));
  assert.match(browserWorkbenchTool.description, /run_steps/i);
  assert.match(browserWorkbenchTool.description, /click\/type\/fill/i);
  assert.match(browserWorkbenchTool.description, /approval/i);
});

test("browser_workbench rejects a pre-aborted call before launching Playwright", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before browser launch"));
  await assert.rejects(
    browserWorkbenchTool.execute(
      "browser-abort",
      { action: "open_url", url: "https://example.com" },
      controller.signal,
    ),
    /cancelled before browser launch/,
  );
});
