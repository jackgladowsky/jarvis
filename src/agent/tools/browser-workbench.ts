import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall } from "../../lib/logger.js";
import { openUrlInWorkbench, runStepsInWorkbench } from "../../workbench/controller.js";
import { renderWorkbenchResult } from "../../workbench/render.js";
import { assessHumanHandoff, assessWorkbenchRequest, approvalIsExplicit } from "../../workbench/safety.js";

const stepSchema = Type.Object({
  action: Type.Union([Type.Literal("open_url"), Type.Literal("click"), Type.Literal("type"), Type.Literal("fill")], {
    description: "Safe basic browser action. submit/download/destructive actions are not implemented.",
  }),
  url: Type.Optional(Type.String({ description: "Public http(s) URL for open_url." })),
  selector: Type.Optional(Type.String({ description: "CSS selector for click/type/fill target." })),
  text: Type.Optional(Type.String({ description: "Visible text for click target, or label text for type/fill." })),
  value: Type.Optional(Type.String({ description: "Non-secret sample text to type/fill. Never pass credentials." })),
});

const approvalSchema = Type.Object({
  approved: Type.Boolean({
    description: "True only after Jack explicitly approves this exact side-effect-risky step.",
  }),
  approvedBy: Type.String({ description: "Approver name." }),
  reason: Type.String({ description: "What was approved and why." }),
});

const schema = Type.Object({
  action: Type.Union([Type.Literal("open_url"), Type.Literal("run_steps")], {
    description: "Open one URL or run a small validated browser step plan.",
  }),
  url: Type.Optional(Type.String({ description: "Public http(s) URL to open for action=open_url." })),
  steps: Type.Optional(Type.Array(stepSchema, { description: "Step plan for action=run_steps.", maxItems: 20 })),
  request: Type.Optional(
    Type.String({
      description:
        "The user's natural-language request. Used only for safety gating; do not include credentials or secrets.",
    }),
  ),
  approval: Type.Optional(approvalSchema),
});

export const browserWorkbenchTool: AgentTool<typeof schema> = {
  name: "browser_workbench",
  label: "browser_workbench",
  description:
    "Run safe local Playwright browser workbench actions with persistent host-local profile/downloads/screenshots/artifacts. Supports open_url and small run_steps plans with benign click/type/fill. Blocks local/private URLs, credentials, login/2FA/CAPTCHA, submits, purchases/orders/bookings/rides/sends/posts/deletes/account/financial/legal/medical actions unless an explicit approval object is present; real purchase/ride/etc. execution is not implemented.",
  parameters: schema,
  async execute(_id, args: Static<typeof schema>) {
    const t0 = Date.now();
    const auditArgs = {
      action: args.action,
      url: args.url,
      steps: args.steps?.map((step) => ({ action: step.action, target: step.selector ?? step.text ?? step.url })),
      request: args.request ? "[provided]" : undefined,
      approval: args.approval ? { approved: args.approval.approved, approvedBy: args.approval.approvedBy } : undefined,
    };

    try {
      const handoff = assessHumanHandoff(args.request ?? "");
      if (handoff.approvalRequired) throw new Error(handoff.reason ?? "Human handoff required.");

      const approval = assessWorkbenchRequest(args.request ?? "");
      if (approval.approvalRequired && !approvalIsExplicit(args.approval)) {
        throw new Error(`${approval.reason} Ask Jack for explicit approval before continuing.`);
      }

      const snapshot =
        args.action === "open_url"
          ? await openUrlInWorkbench(requiredString(args.url, "url is required for open_url"))
          : await runStepsInWorkbench(requiredSteps(args.steps), {
              request: args.request,
              approval: args.approval,
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
      const message = err instanceof Error ? err.message : String(err);
      await auditToolCall({
        tool: "browser_workbench",
        args: auditArgs,
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: message,
      });
      throw err;
    }
  },
};

function requiredString(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredSteps(steps: Static<typeof schema>["steps"]): NonNullable<Static<typeof schema>["steps"]> {
  if (!steps?.length) throw new Error("steps are required for run_steps");
  return steps;
}
