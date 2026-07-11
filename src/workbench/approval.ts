import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { paths } from "../paths.js";
import type { WorkbenchStep } from "./safety.js";

export type WorkbenchApprovalStatus = "pending" | "approved" | "denied" | "consumed";

export interface WorkbenchApprovalRecord {
  id: string;
  chatId: number;
  userId: number;
  planHash: string;
  planSummary: string;
  status: WorkbenchApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
}

const APPROVAL_TTL_MS = 10 * 60_000;
const ID_PATTERN = /^[a-f0-9]{24}$/;

function recordPath(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("invalid browser approval id");
  return join(paths.workbenchApprovals, `${id}.json`);
}

export function canonicalWorkbenchPlan(steps: WorkbenchStep[]): string {
  return JSON.stringify(
    steps.map((step) => ({
      action: step.action,
      url: step.url ? new URL(step.url).toString() : undefined,
      selector: step.selector?.trim() || undefined,
      text: step.text?.trim() || undefined,
      value: step.value,
    })),
  );
}

export function workbenchPlanHash(steps: WorkbenchStep[]): string {
  return createHash("sha256").update(canonicalWorkbenchPlan(steps)).digest("hex");
}

export function summarizeWorkbenchPlan(steps: WorkbenchStep[]): string {
  return steps
    .map((step, index) => `${index + 1}. ${step.action}: ${step.url ?? step.text ?? step.selector ?? "(target)"}`)
    .join("\n")
    .slice(0, 1500);
}

async function readRecord(id: string): Promise<WorkbenchApprovalRecord> {
  const parsed = JSON.parse(await readFile(recordPath(id), "utf-8")) as WorkbenchApprovalRecord;
  if (parsed.id !== id) throw new Error("browser approval record id mismatch");
  return parsed;
}

export async function createWorkbenchApproval(input: {
  chatId: number;
  userId: number;
  steps: WorkbenchStep[];
  now?: Date;
}): Promise<WorkbenchApprovalRecord> {
  const now = input.now ?? new Date();
  const record: WorkbenchApprovalRecord = {
    id: randomBytes(12).toString("hex"),
    chatId: input.chatId,
    userId: input.userId,
    planHash: workbenchPlanHash(input.steps),
    planSummary: summarizeWorkbenchPlan(input.steps),
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
  await mkdir(paths.workbenchApprovals, { recursive: true, mode: 0o700 });
  await atomicWriteJson(recordPath(record.id), record);
  return record;
}

export async function decideWorkbenchApproval(
  id: string,
  identity: { chatId: number; userId: number },
  decision: "approved" | "denied",
  now = new Date(),
): Promise<WorkbenchApprovalRecord> {
  return withFileLock(recordPath(id), async () => {
    const record = await readRecord(id);
    if (record.chatId !== identity.chatId || record.userId !== identity.userId) {
      throw new Error("This browser approval belongs to a different chat or owner.");
    }
    if (Date.parse(record.expiresAt) <= now.getTime()) throw new Error("This browser approval expired.");
    if (record.status !== "pending") throw new Error(`This browser approval is already ${record.status}.`);
    const updated = { ...record, status: decision, decidedAt: now.toISOString() };
    await atomicWriteJson(recordPath(id), updated);
    return updated;
  });
}

/** Consume before executing. A crash therefore fails closed and cannot replay the side effect. */
export async function consumeWorkbenchApproval(
  id: string,
  identity: { chatId: number; userId: number },
  steps: WorkbenchStep[],
  now = new Date(),
): Promise<WorkbenchApprovalRecord> {
  return withFileLock(recordPath(id), async () => {
    const record = await readRecord(id);
    if (record.chatId !== identity.chatId || record.userId !== identity.userId) {
      throw new Error("Browser approval is not valid for this chat and owner.");
    }
    if (record.planHash !== workbenchPlanHash(steps))
      throw new Error("Browser approval does not match this exact plan.");
    if (Date.parse(record.expiresAt) <= now.getTime()) throw new Error("Browser approval expired.");
    if (record.status !== "approved") {
      throw new Error(
        record.status === "consumed" ? "Browser approval was already used." : `Browser approval is ${record.status}.`,
      );
    }
    const updated = { ...record, status: "consumed" as const, consumedAt: now.toISOString() };
    await atomicWriteJson(recordPath(id), updated);
    return updated;
  });
}
