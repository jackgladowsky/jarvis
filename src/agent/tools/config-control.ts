import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import {
  applyConfigChange,
  getConfigView,
  planConfigChange,
  rollbackConfig,
  type ConfigPatchOperation,
} from "../../control/config-control.js";
import { scheduleJarvisRestart } from "../../control/restart.js";
import { resolveModel, switchModel } from "../model.js";
import { withToolAudit } from "./audited.js";
import type { BrowserWorkbenchAuthority } from "./browser-workbench.js";
import { pendingCapabilityResult, requireOwnerCapability } from "../../control/owner-capability.js";

const operationSchema = Type.Object({
  op: Type.Union([Type.Literal("set"), Type.Literal("delete")]),
  path: Type.String({ description: "Dot-separated config path, for example scheduler.timezone." }),
  value: Type.Optional(Type.Any()),
});

const schema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("explain"),
    Type.Literal("plan"),
    Type.Literal("apply"),
    Type.Literal("rollback"),
    Type.Literal("restart"),
  ]),
  operations: Type.Optional(Type.Array(operationSchema, { maxItems: 20 })),
  expected_revision: Type.Optional(Type.String()),
  target_revision: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String({ maxLength: 240 })),
  capability_id: Type.Optional(Type.String()),
});

function operations(args: Static<typeof schema>): ConfigPatchOperation[] {
  return (args.operations ?? []) as ConfigPatchOperation[];
}

function summary(result: {
  previousRevision?: string;
  revision: string;
  changedPaths?: string[];
  restartRequired?: boolean;
  config?: unknown;
}): string {
  return JSON.stringify(
    {
      previous_revision: result.previousRevision,
      revision: result.revision,
      changed_paths: result.changedPaths,
      restart_required: result.restartRequired,
      config: result.config,
    },
    null,
    2,
  );
}

function createRawConfigControlTool(authority?: BrowserWorkbenchAuthority): AgentTool<typeof schema> {
  return {
    name: "config_control",
    label: "config_control",
    description:
      "Safely inspect, explain, plan, apply, or roll back JARVIS config.yaml changes and schedule a guarded restart. Use this instead of editing config.yaml or calling systemctl through bash. Never handles .env or secrets. Always plan first, then apply using the returned expected revision. Restart only after explicitly telling the owner and receiving confirmation.",
    parameters: schema,
    async execute(_id, args) {
      if (args.action === "get" || args.action === "explain") {
        const view = await getConfigView();
        const prefix =
          args.action === "explain"
            ? "This is the validated effective startup configuration. agent.* can switch live; other changes require a guarded restart. Secrets are not part of this file.\n"
            : "";
        return { content: [{ type: "text", text: prefix + summary(view) }], details: view };
      }
      if (args.action === "plan") {
        const plan = await planConfigChange(operations(args));
        return { content: [{ type: "text", text: summary(plan) }], details: plan };
      }
      if (args.action === "apply") {
        if (!args.expected_revision) throw new Error("expected_revision is required for apply");
        const approval = await requireOwnerCapability({
          authority,
          capabilityId: args.capability_id,
          tool: "config apply",
          plan: { action: args.action, expected_revision: args.expected_revision, operations: args.operations },
        });
        if (approval.pending) return pendingCapabilityResult("config apply", approval.pending);
        const proposed = await planConfigChange(operations(args));
        const modelChanged = proposed.changedPaths.some((path) => path.startsWith("agent."));
        if (modelChanged) resolveModel(proposed.config.agent.provider, proposed.config.agent.model);
        const result = await applyConfigChange(args.expected_revision, operations(args));
        if (modelChanged) switchModel(result.config.agent.provider, result.config.agent.model);
        return { content: [{ type: "text", text: summary(result) }], details: result };
      }
      if (args.action === "rollback") {
        if (!args.expected_revision) throw new Error("expected_revision is required for rollback");
        const approval = await requireOwnerCapability({
          authority,
          capabilityId: args.capability_id,
          tool: "config rollback",
          plan: {
            action: args.action,
            expected_revision: args.expected_revision,
            target_revision: args.target_revision,
          },
        });
        if (approval.pending) return pendingCapabilityResult("config rollback", approval.pending);
        const result = await rollbackConfig(args.expected_revision, args.target_revision, (next) => {
          resolveModel(next.agent.provider, next.agent.model);
        });
        if (result.changedPaths.some((path) => path.startsWith("agent."))) {
          resolveModel(result.config.agent.provider, result.config.agent.model);
          switchModel(result.config.agent.provider, result.config.agent.model);
        }
        return { content: [{ type: "text", text: summary(result) }], details: result };
      }
      if (!args.expected_revision) throw new Error("expected_revision is required for restart");
      const approval = await requireOwnerCapability({
        authority,
        capabilityId: args.capability_id,
        tool: "service restart",
        plan: { action: args.action, expected_revision: args.expected_revision, reason: args.reason },
      });
      if (approval.pending) return pendingCapabilityResult("service restart", approval.pending);
      const current = await getConfigView();
      if (current.revision !== args.expected_revision) throw new Error("Config revision changed; restart refused");
      await scheduleJarvisRestart(args.reason ?? "Apply validated configuration", current.revision);
      return {
        content: [
          { type: "text", text: "Guarded restart scheduled for jarvis.service; a back-online notice will follow." },
        ],
        details: { revision: current.revision, scheduled: true },
      };
    },
  };
}

export function createConfigControlTool(authority?: BrowserWorkbenchAuthority) {
  return withToolAudit(createRawConfigControlTool(authority), {
    summarizeArgs: (args) => ({
      action: args.action,
      paths: args.operations?.map((operation) => operation.path),
      operation_count: args.operations?.length ?? 0,
      has_expected_revision: Boolean(args.expected_revision),
      has_target_revision: Boolean(args.target_revision),
      capability_id_provided: Boolean(args.capability_id),
    }),
    summarizeError: () => "config control operation failed",
  });
}

export const configControlTool = createConfigControlTool();
