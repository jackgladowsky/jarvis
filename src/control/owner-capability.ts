import { createHash } from "node:crypto";
import type { BrowserWorkbenchAuthority } from "../agent/tools/browser-workbench.js";
import { consumeWorkbenchApproval, createWorkbenchApproval } from "../workbench/approval.js";
import type { WorkbenchStep } from "../workbench/safety.js";

function canonical(tool: string, plan: unknown): WorkbenchStep[] {
  const json = JSON.stringify(plan);
  const digest = createHash("sha256").update(`${tool}\0${json}`).digest("hex");
  return [
    { action: "submit", text: `JARVIS owner control: ${tool} (${digest.slice(0, 16)})`, value: json.slice(0, 160) },
  ];
}

async function ownerApprovalRequired(override: boolean | undefined): Promise<boolean> {
  if (override !== undefined) return override;
  return (await import("../config.js")).config.tools.owner_approval.required;
}

export async function requireOwnerCapability(input: {
  authority?: BrowserWorkbenchAuthority;
  capabilityId?: string;
  tool: string;
  plan: unknown;
  /** Test seam; production callers use the startup-frozen config policy. */
  approvalRequired?: boolean;
}): Promise<{ pending?: { id: string; expiresAt: string } }> {
  if (!(await ownerApprovalRequired(input.approvalRequired))) return {};
  if (!input.authority) throw new Error(`${input.tool} requires an active authenticated Telegram owner chat.`);
  const steps = canonical(input.tool, input.plan);
  if (!input.capabilityId) {
    const record = await createWorkbenchApproval({
      chatId: input.authority.chatId,
      userId: input.authority.userId,
      steps,
    });
    await input.authority.requestApproval(record);
    return { pending: { id: record.id, expiresAt: record.expiresAt } };
  }
  await consumeWorkbenchApproval(input.capabilityId, input.authority, steps);
  return {};
}

export function pendingCapabilityResult(tool: string, pending: { id: string; expiresAt: string }) {
  return {
    content: [
      {
        type: "text" as const,
        text: `PENDING_OWNER_APPROVAL ${pending.id}\nApprove the exact ${tool} plan in Telegram, then retry unchanged with capability_id.`,
      },
    ],
    details: { status: "pending_approval", approvalId: pending.id, expiresAt: pending.expiresAt },
  };
}
