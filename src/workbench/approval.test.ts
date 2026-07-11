import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { paths } from "../paths.js";
import {
  consumeWorkbenchApproval,
  createWorkbenchApproval,
  decideWorkbenchApproval,
  workbenchPlanHash,
} from "./approval.js";
import type { WorkbenchStep } from "./safety.js";

const plan: WorkbenchStep[] = [
  { action: "open_url", url: "https://example.com/path" },
  { action: "submit", text: "Send" },
];

async function reset(): Promise<void> {
  await rm(paths.workbenchApprovals, { recursive: true, force: true });
}

test("approval summaries show benign values but redact secret-like values with a digest", async () => {
  const { summarizeWorkbenchPlan } = await import("./approval.js");
  assert.match(
    summarizeWorkbenchPlan([{ action: "fill", text: "query", value: "weather tomorrow" }]),
    /weather tomorrow/,
  );
  const secret = summarizeWorkbenchPlan([{ action: "fill", text: "query", value: "Bearer super-secret-token-value" }]);
  assert.match(secret, /\[redacted \d+ chars sha256:[a-f0-9]{12}\]/);
  assert.doesNotMatch(secret, /super-secret-token-value/);
});

test("approval is bound to owner/chat and exact normalized plan", async () => {
  await reset();
  const record = await createWorkbenchApproval({ chatId: 7, userId: 9, steps: plan });
  assert.equal(record.planHash, workbenchPlanHash(plan));
  await assert.rejects(() => decideWorkbenchApproval(record.id, { chatId: 8, userId: 9 }, "approved"), /different/);
  await decideWorkbenchApproval(record.id, { chatId: 7, userId: 9 }, "approved");
  await assert.rejects(
    () => consumeWorkbenchApproval(record.id, { chatId: 7, userId: 9 }, [...plan, { action: "click", text: "Other" }]),
    /exact plan/,
  );
  assert.equal((await consumeWorkbenchApproval(record.id, { chatId: 7, userId: 9 }, plan)).status, "consumed");
});

test("approval expires, denial is final, and consumption cannot replay", async () => {
  await reset();
  const expired = await createWorkbenchApproval({ chatId: 1, userId: 2, steps: plan, now: new Date(0) });
  await assert.rejects(
    () => decideWorkbenchApproval(expired.id, { chatId: 1, userId: 2 }, "approved", new Date(600_001)),
    /expired/,
  );

  const denied = await createWorkbenchApproval({ chatId: 1, userId: 2, steps: plan });
  await decideWorkbenchApproval(denied.id, { chatId: 1, userId: 2 }, "denied");
  await assert.rejects(() => consumeWorkbenchApproval(denied.id, { chatId: 1, userId: 2 }, plan), /denied/);

  const once = await createWorkbenchApproval({ chatId: 1, userId: 2, steps: plan });
  await decideWorkbenchApproval(once.id, { chatId: 1, userId: 2 }, "approved");
  await consumeWorkbenchApproval(once.id, { chatId: 1, userId: 2 }, plan);
  await assert.rejects(() => consumeWorkbenchApproval(once.id, { chatId: 1, userId: 2 }, plan), /already used/);
});
