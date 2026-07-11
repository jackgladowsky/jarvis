import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "grammy";
import { InputFile } from "grammy";
import type { PreparedArtifact } from "../agent/tools/send-artifact.js";
import { deliverTelegramArtifact } from "./telegram.js";

test("Telegram artifact delivery uses InputFile, retries transient failure, and threads the upload", async () => {
  const calls: Array<{ document: InputFile; options: Record<string, unknown> }> = [];
  let attempt = 0;
  const ctx = {
    replyWithDocument: async (document: InputFile, options: Record<string, unknown>) => {
      calls.push({ document, options });
      attempt += 1;
      if (attempt === 1) throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      return { message_id: 77 };
    },
  } as unknown as Context;
  const artifact: PreparedArtifact = {
    path: "/tmp/report.pdf",
    fileName: "report.pdf",
    size: 123,
    mimeType: "application/pdf",
    caption: "Requested report",
  };

  assert.deepEqual(await deliverTelegramArtifact(ctx, artifact, { message_id: 12 }), { messageId: 77 });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.document instanceof InputFile);
  assert.equal(calls[1]?.document.filename, "report.pdf");
  assert.equal((calls[1]?.document as unknown as { fileData: string }).fileData, "/tmp/report.pdf");
  assert.deepEqual(calls[1]?.options, {
    caption: "Requested report",
    reply_parameters: { message_id: 12, allow_sending_without_reply: true },
  });
});
