import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall } from "../../lib/logger.js";
import {
  consumeWorkbenchApproval,
  createWorkbenchApproval,
  type WorkbenchApprovalRecord,
} from "../../workbench/approval.js";
import { openUrlInWorkbench, runStepsInWorkbench } from "../../workbench/controller.js";
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
  action: Type.Union([Type.Literal("open_url"), Type.Literal("run_steps")]),
  url: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(stepSchema, { maxItems: 20 })),
  request: Type.Optional(Type.String({ description: "The user's natural-language request, without secrets." })),
  capabilityId: Type.Optional(
    Type.String({ description: "Owner-issued approval id returned by a prior pending browser request." }),
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
            ? await openUrlInWorkbench(requiredString(args.url, "url is required for open_url"), { signal })
            : await runStepsInWorkbench(steps, { request: args.request, capabilityGranted, signal });
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
