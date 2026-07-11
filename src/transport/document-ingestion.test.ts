import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "grammy";
import { documentCandidate } from "./telegram.js";

function context(document: { file_id: string; mime_type?: string; file_name?: string; file_size?: number }): Context {
  return { message: { document } } as unknown as Context;
}

test("ordinary Telegram documents are selected after image and audio precedence", () => {
  assert.deepEqual(
    documentCandidate(context({ file_id: "text", mime_type: "text/plain", file_name: "notes.txt", file_size: 12 })),
    {
      fileId: "text",
      mimeType: "text/plain",
      fileName: "notes.txt",
      fileSize: 12,
    },
  );
  assert.equal(documentCandidate(context({ file_id: "image", mime_type: "image/png", file_name: "x.png" })), undefined);
  assert.equal(
    documentCandidate(context({ file_id: "audio", mime_type: "application/octet-stream", file_name: "x.ogg" })),
    undefined,
  );
});
