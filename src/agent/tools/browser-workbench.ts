import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall } from "../../lib/logger.js";
import { openUrlInWorkbench } from "../../workbench/controller.js";
import { renderWorkbenchResult } from "../../workbench/render.js";
import { assessWorkbenchRequest, assertReadOnlyWorkbenchAction } from "../../workbench/safety.js";

const schema = Type.Object({
  action: Type.Literal("open_url", {
    description: "Read-only action: open a public http(s) URL in the local browser workbench.",
  }),
  url: Type.String({ description: "Public http(s) URL to open." }),
  request: Type.Optional(
    Type.String({
      description:
        "The user's natural-language request. Used only for safety gating; do not include credentials or secrets.",
    }),
  ),
});

export const browserWorkbenchTool: AgentTool<typeof schema> = {
  name: "browser_workbench",
  label: "browser_workbench",
  description:
    "Open a public http(s) URL in JARVIS's local-only Playwright browser workbench, capture title/visible text/screenshot/artifact paths, and return safe text results. Read-only in this version. Requires hard human approval for purchases/orders/bookings/sends/posts/deletes/account/financial/legal/medical actions and never bypasses CAPTCHA/login/2FA.",
  parameters: schema,
  async execute(_id, args: Static<typeof schema>) {
    const t0 = Date.now();
    const approval = assessWorkbenchRequest(args.request ?? "");
    const action = assertReadOnlyWorkbenchAction(args.action);

    try {
      if (!action.allowed) throw new Error(action.reason ?? "Workbench action is blocked.");
      if (approval.approvalRequired) {
        throw new Error(`${approval.reason} Ask Jack for explicit approval before continuing.`);
      }

      const snapshot = await openUrlInWorkbench(args.url);
      await auditToolCall({
        tool: "browser_workbench",
        args: { action: args.action, url: args.url, request: args.request ? "[provided]" : undefined },
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
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await auditToolCall({
        tool: "browser_workbench",
        args: { action: args.action, url: args.url, request: args.request ? "[provided]" : undefined },
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: message,
      });
      throw err;
    }
  },
};
