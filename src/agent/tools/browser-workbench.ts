import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { config } from "../../config.js";
import { auditToolCall } from "../../lib/logger.js";
import {
  consumeWorkbenchApproval,
  createWorkbenchApproval,
  type WorkbenchApprovalRecord,
} from "../../workbench/approval.js";
import { openUrlInWorkbench, runStepsInWorkbench } from "../../workbench/controller.js";
import { getKernelAuthStatus, startKernelAuth, type KernelSettings } from "../../workbench/kernel.js";
import { renderWorkbenchResult } from "../../workbench/render.js";
import { type WorkbenchStep, validateWorkbenchSteps, workbenchPlanRequiresCapability } from "../../workbench/safety.js";

const stepSchema = Type.Object({
  action: Type.Union([
    Type.Literal("open_url"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("fill"),
    Type.Literal("submit"),
  ]),
  url: Type.Optional(Type.String()),
  selector: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  value: Type.Optional(Type.String({ description: "Non-secret text only. Never pass credentials." })),
});

const schema = Type.Object({
  action: Type.Union([
    Type.Literal("open_url"),
    Type.Literal("run_steps"),
    Type.Literal("kernel_auth_start"),
    Type.Literal("kernel_auth_status"),
  ]),
  url: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(stepSchema, { maxItems: 20 })),
  request: Type.Optional(Type.String({ description: "The user's natural-language request, without secrets." })),
  capabilityId: Type.Optional(
    Type.String({ description: "Owner-issued approval id returned by a prior pending browser request." }),
  ),
  domain: Type.Optional(Type.String({ description: "Public domain for a user-completed Kernel hosted login." })),
  profileName: Type.Optional(Type.String({ description: "Safe Kernel profile name; no credentials or cookies." })),
  connectionId: Type.Optional(
    Type.String({ description: "Safe Kernel auth connection identifier for status lookup." }),
  ),
});

type BrowserArgs = Static<typeof schema>;

export interface BrowserWorkbenchAuthority {
  chatId: number;
  userId: number;
  requestApproval: (record: WorkbenchApprovalRecord) => Promise<void>;
}

export function createBrowserWorkbenchTool(authority?: BrowserWorkbenchAuthority): AgentTool<typeof schema> {
  return {
    name: "browser_workbench",
    label: "browser_workbench",
    description:
      "Open public web pages or use run_steps for guarded click/type/fill/submit browser actions. Reading and benign clicks/fills are automatic. Submit or external side-effect actions require an owner-issued one-time Telegram approval capability. The tool creates that approval request when needed; never invent capabilityId. Credentials/login/2FA/CAPTCHA and purchases remain blocked.",
    parameters: schema,
    async execute(_id, args: BrowserArgs, signal) {
      const t0 = Date.now();
      if (args.action === "kernel_auth_start" || args.action === "kernel_auth_status") {
        return executeKernelAuth(args, authority, t0);
      }
      const steps = normalizedSteps(args);
      const auditArgs = {
        action: args.action,
        url: args.url,
        steps: steps.map((step) => ({ action: step.action, target: step.selector ?? step.text ?? step.url })),
        request: args.request ? "[provided]" : undefined,
        capabilityId: args.capabilityId ? "[provided]" : undefined,
      };
      try {
        // Validate with authority enabled first so permanent hard blocks are rejected before an approval is requested.
        const preflight = validateWorkbenchSteps(steps, { request: args.request, hasCapability: true });
        if (!preflight.allowed) throw new Error(preflight.reason ?? "Workbench plan is blocked.");

        const requiresCapability = workbenchPlanRequiresCapability(steps, args.request);
        let capabilityGranted = false;
        if (requiresCapability) {
          if (!authority) throw new Error("This browser action requires approval from an active Telegram owner chat.");
          if (!args.capabilityId) {
            const pending = await createWorkbenchApproval({
              chatId: authority.chatId,
              userId: authority.userId,
              steps,
            });
            await authority.requestApproval(pending);
            await auditToolCall({
              tool: "browser_workbench",
              args: auditArgs,
              outcome: "ok",
              duration_ms: Date.now() - t0,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `PENDING_OWNER_APPROVAL ${pending.id}\nThe exact browser plan was sent to Telegram. Stop and wait for the owner to approve or deny it. After approval, call this exact plan once with capabilityId "${pending.id}".`,
                },
              ],
              details: { status: "pending_approval", approvalId: pending.id, expiresAt: pending.expiresAt },
            };
          }
          await consumeWorkbenchApproval(args.capabilityId, authority, steps);
          capabilityGranted = true;
        } else if (args.capabilityId) {
          throw new Error("A capability cannot be attached to a different or non-gated browser plan.");
        }

        const snapshot =
          args.action === "open_url"
            ? await openUrlInWorkbench(requiredString(args.url, "url is required for open_url"), {
                signal,
                ...browserBackendOptions(),
              })
            : await runStepsInWorkbench(steps, {
                request: args.request,
                capabilityGranted,
                signal,
                ...browserBackendOptions(),
              });
        await auditToolCall({
          tool: "browser_workbench",
          args: auditArgs,
          outcome: "ok",
          duration_ms: Date.now() - t0,
        });
        return {
          content: [{ type: "text", text: renderWorkbenchResult(snapshot) }],
          details: {
            finalUrl: snapshot.finalUrl,
            title: snapshot.title,
            screenshotPath: snapshot.screenshotPath,
            artifactPath: snapshot.artifactPath,
            capturedAt: snapshot.capturedAt,
            steps: snapshot.steps,
          },
        };
      } catch (err) {
        await auditToolCall({
          tool: "browser_workbench",
          args: auditArgs,
          outcome: "error",
          duration_ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

export const browserWorkbenchTool = createBrowserWorkbenchTool();

function normalizedSteps(args: BrowserArgs): WorkbenchStep[] {
  if (args.action === "open_url") {
    return [{ action: "open_url", url: requiredString(args.url, "url is required for open_url") }];
  }
  if (!args.steps?.length) throw new Error("steps are required for run_steps");
  return args.steps;
}

function requiredString(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function kernelSettings(): KernelSettings {
  const kernel = config.tools.browser.kernel;
  return { apiKeyEnv: kernel.api_key_env, profileName: kernel.profile_name, saveChanges: kernel.save_changes };
}

function browserBackendOptions(): { backend: "local" | "kernel"; kernel?: KernelSettings } {
  return config.tools.browser.backend === "kernel"
    ? { backend: "kernel", kernel: kernelSettings() }
    : { backend: "local" };
}

function authPlan(args: BrowserArgs): WorkbenchStep[] {
  return [
    {
      action: "submit",
      text: `Start Kernel hosted authentication for ${requiredString(args.domain, "domain is required for kernel_auth_start")}`,
      selector: requiredString(args.profileName, "profileName is required for kernel_auth_start"),
    },
  ];
}

function formatAuthStatus(status: {
  id: string;
  domain: string;
  profileName: string;
  status: string;
  flowStatus: string | null;
  flowStep: string | null;
  flowExpiresAt: string | null;
}): string {
  return [
    `Kernel auth connection: ${status.id}`,
    `Domain: ${status.domain}`,
    `Profile: ${status.profileName}`,
    `Status: ${status.status}`,
    `Flow: ${status.flowStatus ?? "none"}${status.flowStep ? ` (${status.flowStep})` : ""}`,
    status.flowExpiresAt ? `Expires: ${status.flowExpiresAt}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function executeKernelAuth(args: BrowserArgs, authority: BrowserWorkbenchAuthority | undefined, t0: number) {
  const auditArgs = {
    action: args.action,
    domain: args.domain,
    profileName: args.profileName,
    connectionId: args.connectionId,
    capabilityId: args.capabilityId ? "[provided]" : undefined,
  };
  try {
    if (config.tools.browser.backend !== "kernel")
      throw new Error("Kernel auth requires tools.browser.backend: kernel.");
    const settings = kernelSettings();
    if (args.action === "kernel_auth_status") {
      if (args.capabilityId)
        throw new Error("A capability cannot be attached to a read-only Kernel auth status request.");
      const status = await getKernelAuthStatus(
        settings,
        requiredString(args.connectionId, "connectionId is required for kernel_auth_status"),
      );
      await auditToolCall({ tool: "browser_workbench", args: auditArgs, outcome: "ok", duration_ms: Date.now() - t0 });
      return { content: [{ type: "text" as const, text: formatAuthStatus(status) }], details: { status } };
    }
    const plan = authPlan(args);
    if (!authority) throw new Error("Kernel auth start requires approval from an active Telegram owner chat.");
    if (!args.capabilityId) {
      const pending = await createWorkbenchApproval({
        chatId: authority.chatId,
        userId: authority.userId,
        steps: plan,
      });
      await authority.requestApproval(pending);
      await auditToolCall({ tool: "browser_workbench", args: auditArgs, outcome: "ok", duration_ms: Date.now() - t0 });
      return {
        content: [
          {
            type: "text" as const,
            text: `PENDING_OWNER_APPROVAL ${pending.id}\nApprove the exact hosted-auth setup before JARVIS creates it.`,
          },
        ],
        details: { status: "pending_approval", approvalId: pending.id, expiresAt: pending.expiresAt },
      };
    }
    await consumeWorkbenchApproval(args.capabilityId, authority, plan);
    const result = await startKernelAuth(settings, {
      domain: requiredString(args.domain, "domain is required for kernel_auth_start"),
      profileName: requiredString(args.profileName, "profileName is required for kernel_auth_start"),
    });
    await auditToolCall({ tool: "browser_workbench", args: auditArgs, outcome: "ok", duration_ms: Date.now() - t0 });
    // Hosted URL is returned only in this approved, in-memory Telegram response; it is never persisted.
    return {
      content: [
        {
          type: "text" as const,
          text: `Open this Kernel-hosted page yourself and complete login/2FA/CAPTCHA there:\n${result.hostedUrl}\n\n${formatAuthStatus(result.status)}`,
        },
      ],
      details: { connectionId: result.status.id, status: result.status.status, expiresAt: result.expiresAt },
    };
  } catch (err) {
    await auditToolCall({
      tool: "browser_workbench",
      args: auditArgs,
      outcome: "error",
      duration_ms: Date.now() - t0,
      error: err instanceof Error ? err.message : "Kernel auth failed",
    });
    throw err;
  }
}
