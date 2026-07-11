import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "./index.js";
import { createConfigControlTool } from "./config-control.js";
import { diagnosticsTool } from "./diagnostics.js";
import { createMcpCallTool } from "./mcp.js";
import { createMcpManagerTool } from "./mcp-manager.js";
import { schedulerControlTool } from "./scheduler-control.js";
import { createSearchMemoryTool } from "./search-memory.js";

// allTools is the scheduled/background baseline. Owner-bound capabilities are injected only by handleMessage.
test("scheduled/background baseline excludes every owner-control capability", () => {
  const names = new Set(allTools.map((tool) => tool.name));
  for (const ownerOnly of [
    "config_control",
    "diagnostics",
    "scheduler_control",
    "search_memory",
    "mcp_manage",
    "send_artifact",
  ]) {
    assert.equal(names.has(ownerOnly), false, `${ownerOnly} leaked into automation baseline`);
  }
  assert.equal(names.has("mcp_call"), true, "read-only public HTTP MCP automation remains available");

  const authority = { chatId: 1, userId: 1, requestApproval: async () => undefined };
  const interactive = [
    createConfigControlTool(authority),
    diagnosticsTool,
    schedulerControlTool,
    createSearchMemoryTool(authority),
    createMcpManagerTool(authority),
    createMcpCallTool(authority),
  ];
  assert.deepEqual(interactive.map((tool) => tool.name).sort(), [
    "config_control",
    "diagnostics",
    "mcp_call",
    "mcp_manage",
    "scheduler_control",
    "search_memory",
  ]);
});
