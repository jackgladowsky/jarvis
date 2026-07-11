import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "./index.js";
import { diagnosticsTool, summarizeDiagnosticsAuditArgs } from "./diagnostics.js";

test("diagnostics is natural-language routable and audit metadata is bounded", () => {
  assert.ok(
    !allTools.some((tool) => tool.name === "diagnostics"),
    "owner-control diagnostics must not reach scheduled/background runs",
  );
  assert.match(diagnosticsTool.description, /health checks conversationally/i);
  const summary = summarizeDiagnosticsAuditArgs({
    action: "repair_by_finding_id",
    finding_id: "permissions-insecure",
    probe_telegram: true,
  });
  assert.deepEqual(summary, {
    action: "repair_by_finding_id",
    finding_id: "permissions-insecure",
    telegram_probe: true,
  });
  assert.doesNotMatch(JSON.stringify(summary), /token|credential|config value/i);
});
