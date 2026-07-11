import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "./index.js";
import { summarizeMcpManagerAuditArgs, summarizeMcpManagerAuditError } from "./mcp-manager.js";

test("mcp manager is naturally routable and audit metadata excludes configuration values", () => {
  assert.ok(allTools.some((tool) => tool.name === "mcp_manage"));
  const summary = summarizeMcpManagerAuditArgs({
    action: "add",
    server: "calendar",
    config: {
      url: "https://private-host.example/mcp",
      headers: { Authorization: "Bearer $TOP_SECRET_TOKEN" },
    },
  });
  assert.deepEqual(summary, { action: "add", server: "calendar", transport: "http" });
  assert.doesNotMatch(JSON.stringify(summary), /private-host|TOP_SECRET|Authorization/);
  assert.doesNotMatch(
    summarizeMcpManagerAuditError(new Error("TOP_SECRET_TOKEN=value"), {
      action: "test",
      server: "calendar",
    }),
    /TOP_SECRET_TOKEN|value/,
  );
});
