import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import { chromium } from "playwright";
import { config, env } from "../../config.js";
import { repairDiagnosticFinding, runDiagnostics, type DiagnosticsContext } from "../../diagnostics/service.js";
import { manageMcp } from "../../integrations/mcp-manager.js";
import { paths } from "../../paths.js";
import { loadMcpServers, MCP_CONFIG_PATH } from "./mcp.js";
import { withToolAudit } from "./audited.js";

const schema = Type.Object(
  {
    action: Type.Union([Type.Literal("diagnose"), Type.Literal("repair_by_finding_id")]),
    finding_id: Type.Optional(Type.String({ maxLength: 120 })),
    probe_telegram: Type.Optional(
      Type.Boolean({ description: "Run Telegram getMe. This is read-only but makes an external request." }),
    ),
  },
  { additionalProperties: false },
);

function context(): DiagnosticsContext {
  return {
    config,
    env,
    paths: {
      data: paths.data,
      configYaml: paths.configYaml,
      cache: paths.cache,
      env: paths.env,
      scheduledJobTasks: paths.scheduledJobTasks,
      backgroundTasks: paths.backgroundTasks,
      internalNotifications: paths.internalNotifications,
      internalNotificationsHeartbeat: paths.internalNotificationsHeartbeat,
      deployPending: paths.deployPending,
      configRestartPending: paths.configRestartPending,
      workbench: paths.workbench,
    },
  };
}

const rawDiagnosticsTool: AgentTool<typeof schema> = {
  name: "diagnostics",
  label: "Diagnose and safely repair JARVIS",
  description:
    "Run bounded, secret-safe JARVIS health checks conversationally, or apply a narrowly allowlisted repair using an exact finding id from the latest diagnosis. Repairs are limited to host-local permissions, old regenerable cache files, and stale dead-owner locks. Credential changes, packages, restarts, and destructive cleanup are proposals only.",
  parameters: schema,
  async execute(_id, args: Static<typeof schema>) {
    if (args.action === "repair_by_finding_id") {
      if (!args.finding_id) throw new Error("finding_id is required for repair_by_finding_id");
      const result = await repairDiagnosticFinding(context(), args.finding_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    }
    const result = await runDiagnostics(
      context(),
      { probeTelegram: args.probe_telegram },
      {
        chromiumPath: () => chromium.executablePath(),
        mcpHealth: async (signal) => {
          const mcp = await loadMcpServers(MCP_CONFIG_PATH);
          return Promise.all(
            Object.keys(mcp.servers).map(async (name) => {
              try {
                await manageMcp({ action: "test", server: name }, signal);
                return { name, ok: true };
              } catch {
                return { name, ok: false };
              }
            }),
          );
        },
      },
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
  },
};

export function summarizeDiagnosticsAuditArgs(args: Static<typeof schema>): unknown {
  return {
    action: args.action,
    finding_id: args.finding_id,
    telegram_probe: args.probe_telegram === true,
  };
}

export const diagnosticsTool = withToolAudit(rawDiagnosticsTool, {
  summarizeArgs: summarizeDiagnosticsAuditArgs,
  summarizeError: () => "diagnostic operation failed (details omitted)",
});
