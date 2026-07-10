import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableTelegramError,
  readResponseBodyLimited,
  TelegramHttpError,
  telegramRetryAfterMs,
  withTelegramRetry,
} from "./telegram-delivery.js";

test("Telegram retry classification distinguishes transient from malformed requests", () => {
  assert.equal(isRetryableTelegramError(new TelegramHttpError(429, "slow down", 2)), true);
  assert.equal(isRetryableTelegramError(new TelegramHttpError(503, "unavailable")), true);
  assert.equal(isRetryableTelegramError(new TelegramHttpError(400, "bad request")), false);
  assert.equal(isRetryableTelegramError(new Error("wrapper", { cause: new TypeError("fetch failed") })), true);
  assert.equal(telegramRetryAfterMs(new TelegramHttpError(429, "slow down", 2)), 2_000);
});

test("withTelegramRetry repeats transient calls and preserves permanent failures", async () => {
  let attempts = 0;
  const result = await withTelegramRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw new TelegramHttpError(503, "unavailable");
      return "ok";
    },
    { attempts: 2 },
  );
  assert.equal(result, "ok");
  assert.equal(attempts, 2);

  await assert.rejects(
    withTelegramRetry(async () => {
      throw new TelegramHttpError(400, "bad request");
    }),
    /bad request/,
  );
});

test("readResponseBodyLimited enforces declared and streamed byte limits", async () => {
  assert.equal((await readResponseBodyLimited(new Response("hello"), 5)).toString("utf-8"), "hello");
  await assert.rejects(readResponseBodyLimited(new Response("too large"), 3), /too large/);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("ab"));
      controller.enqueue(Buffer.from("cd"));
      controller.close();
    },
  });
  await assert.rejects(readResponseBodyLimited(new Response(stream), 3), /too large/);
});
