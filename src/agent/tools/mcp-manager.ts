import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "typebox";
import { manageMcp, type McpManagerRequest } from "../../integrations/mcp-manager.js";
import type { BrowserWorkbenchAuthority } from "./browser-workbench.js";
import { pendingCapabilityResult, requireOwnerCapability } from "../../control/owner-capability.js";

const serverConfigSchema = Type.Object(
  {
    command: Type.Optional(Type.String({ description: "stdio executable; use env references for credentials" })),
    args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
    env: Type.Optional(
      Type.Record(Type.String(), Type.String({ description: "Environment reference such as $CALENDAR_TOKEN" })),
    ),
    url: Type.Optional(Type.String({ description: "Public MCP HTTP endpoint without embedded credentials" })),
    headers: Type.Optional(
      Type.Record(
        Type.String(),
        Type.String({ description: "Header containing an env reference, e.g. Bearer $TOKEN" }),
      ),
    ),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 120_000 })),
    read_only: Type.Optional(
      Type.Boolean({ description: "Declare whether this integration should be used read-only" }),
    ),
    allow_localhost: Type.Optional(
      Type.Boolean({
        description: "Explicitly allow only an http:// localhost or literal-loopback HTTP MCP endpoint",
      }),
    ),
  },
  { additionalProperties: false },
);

const schema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("add"),
      Type.Literal("update"),
      Type.Literal("remove"),
      Type.Literal("test"),
      Type.Literal("reload"),
      Type.Literal("discover_tools"),
    ]),
    server: Type.Optional(Type.String({ description: "Lowercase server name for all actions except list/reload" })),
    config: Type.Optional(serverConfigSchema),
    capability_id: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export function summarizeMcpManagerAuditArgs(params: Static<typeof schema>): unknown {
  const config = params.config;
  return {
    action: params.action,
    server: params.server,
    transport: config?.url ? "http" : config?.command ? "stdio" : undefined,
  };
}

export function summarizeMcpManagerAuditError(_error: unknown, params: Static<typeof schema>): string {
  return `MCP manager ${params.action}${params.server ? ` for ${params.server}` : ""} failed (details omitted)`;
}

export function createMcpManagerTool(authority?: BrowserWorkbenchAuthority): AgentTool<typeof schema> {
  return {
    name: "mcp_manage",
    label: "Manage MCP integrations",
    description:
      "Manage host-local MCP integrations conversationally. List, add, replace, remove, health-test, reload/validate, or discover tools. " +
      "Credential fields accept environment-variable references only, never raw secret values. Prefer read_only=true unless the owner explicitly asks for write authority.",
    parameters: schema,
    execute: async (_toolCallId, params, signal) => {
      const gated = ["add", "update", "remove", "test", "discover_tools"].includes(params.action);
      if (gated) {
        const approval = await requireOwnerCapability({
          authority,
          capabilityId: params.capability_id,
          tool: "MCP management",
          plan: { action: params.action, server: params.server, config: params.config },
        });
        if (approval.pending) return pendingCapabilityResult("MCP management", approval.pending);
      }
      const result = await manageMcp(params as McpManagerRequest, signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], details: result };
    },
  };
}
export const mcpManagerTool = createMcpManagerTool();
