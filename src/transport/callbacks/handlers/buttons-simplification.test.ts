import test from "node:test";
import assert from "node:assert/strict";
import type { Context } from "grammy";
import { buildBackgroundKeyboard, handleLegacyBackgroundCallback } from "./background.js";
import { handleLegacyToggleCallback } from "./toggle.js";

function fakeCallbackCtx(calls: string[]): Context {
  return {
    answerCallbackQuery: async (payload: { text?: string }) => {
      calls.push(`answer:${payload.text ?? ""}`);
      return true;
    },
    editMessageReplyMarkup: async (payload?: { reply_markup?: unknown }) => {
      calls.push(`editMarkup:${payload?.reply_markup === undefined ? "cleared" : "set"}`);
      return true;
    },
  } as unknown as Context;
}

test("background notifications intentionally render without inline action buttons", () => {
  assert.equal(buildBackgroundKeyboard({ title: "task-id done", body: "ready" }), undefined);
  assert.equal(buildBackgroundKeyboard({ title: "task-id asking", body: "question" }), undefined);
  assert.equal(buildBackgroundKeyboard({ title: "task-id failed", body: "needs fix" }), undefined);
});

test("legacy background buttons are acknowledged and removed when tapped", async () => {
  const calls: string[] = [];
  await handleLegacyBackgroundCallback(fakeCallbackCtx(calls), "bg:review:hush-tiger");

  assert.deepEqual(calls, ["answer:Buttons removed — use /task, /answer, /fixbg, or /cancelbg.", "editMarkup:cleared"]);
});

test("legacy status/reasoning toggle buttons are acknowledged and removed when tapped", async () => {
  const calls: string[] = [];
  await handleLegacyToggleCallback(fakeCallbackCtx(calls), "toggle:reasoning:high");

  assert.deepEqual(calls, ["answer:Buttons removed — use /thinking, /verbose, or /reasoning.", "editMarkup:cleared"]);
});
