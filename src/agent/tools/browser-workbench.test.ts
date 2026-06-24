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
