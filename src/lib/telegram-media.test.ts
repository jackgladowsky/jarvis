import assert from "node:assert/strict";
import test from "node:test";
import { downloadTelegramFile } from "./telegram-media.js";

const api = { getFile: async () => ({ file_path: "documents/file.txt" }) };

test("Telegram media download enforces declared and streamed byte caps", async () => {
  await assert.rejects(
    () => downloadTelegramFile(api, "token", { fileId: "id", fileSize: 11 }, { maxBytes: 10, timeoutMs: 1_000 }),
    /too large/,
  );

  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  await assert.rejects(
    () => downloadTelegramFile(api, "token", { fileId: "id" }, { maxBytes: 10, timeoutMs: 1_000, fetchImpl }),
    /too large/,
  );
});

test("Telegram media download times out metadata lookup", async () => {
  await assert.rejects(
    () =>
      downloadTelegramFile(
        { getFile: () => new Promise(() => undefined) },
        "token",
        { fileId: "id" },
        { maxBytes: 10, timeoutMs: 5 },
      ),
    /getFile timed out/,
  );
});

test("Telegram media download returns bounded bytes and normalized MIME", async () => {
  let requested = "";
  const result = await downloadTelegramFile(
    api,
    "secret-token",
    { fileId: "id" },
    {
      maxBytes: 100,
      timeoutMs: 1_000,
      fetchImpl: async (input) => {
        requested = String(input);
        return new Response("hello", { headers: { "content-type": "Text/Plain; charset=utf-8" } });
      },
    },
  );
  assert.equal(result.bytes.toString(), "hello");
  assert.equal(result.responseMimeType, "text/plain");
  assert.match(requested, /secret-token/);
});
