import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const data = await mkdtemp(join(tmpdir(), "jarvis-owner-capability-"));
process.env.JARVIS_DATA_DIR = data;
const { requireOwnerCapability } = await import("./owner-capability.js");
const { decideWorkbenchApproval } = await import("../workbench/approval.js");

test("owner capability is chat-bound, exact-plan, expiring, and one-time", async () => {
  let requested = "";
  const authority = {
    chatId: 11,
    userId: 22,
    requestApproval: async (record: { id: string }) => {
      requested = record.id;
    },
  };
  const first = await requireOwnerCapability({
    authority,
    tool: "config apply",
    plan: { revision: "a" },
    approvalRequired: true,
  });
  assert.equal(first.pending?.id, requested);
  await assert.rejects(decideWorkbenchApproval(requested, { chatId: 99, userId: 22 }, "approved"), /different chat/);
  await decideWorkbenchApproval(requested, authority, "approved");
  await assert.rejects(
    requireOwnerCapability({
      authority,
      capabilityId: requested,
      tool: "config apply",
      plan: { revision: "b" },
      approvalRequired: true,
    }),
    /exact plan/,
  );
  await requireOwnerCapability({
    authority,
    capabilityId: requested,
    tool: "config apply",
    plan: { revision: "a" },
    approvalRequired: true,
  });
  await assert.rejects(
    requireOwnerCapability({
      authority,
      capabilityId: requested,
      tool: "config apply",
      plan: { revision: "a" },
      approvalRequired: true,
    }),
    /already used/,
  );
});

test("approval-free policy bypasses normal owner capability prompts", async () => {
  let prompted = false;
  const result = await requireOwnerCapability({
    authority: { chatId: 11, userId: 22, requestApproval: async () => void (prompted = true) },
    tool: "config apply",
    plan: { revision: "a" },
    approvalRequired: false,
  });
  assert.deepEqual(result, {});
  assert.equal(prompted, false);
});

test.after(async () => rm(data, { recursive: true, force: true }));
