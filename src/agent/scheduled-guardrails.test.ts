import assert from "node:assert/strict";
import test from "node:test";
import { isContextWindowError } from "./scheduled-guardrails.js";

test("isContextWindowError matches provider context-limit wording only", () => {
  assert.equal(isContextWindowError("Your input exceeds the context window of this model."), true);
  assert.equal(isContextWindowError(new Error("maximum context length is 128000 tokens")), true);
  assert.equal(isContextWindowError("Our servers are currently overloaded. Please try again later."), false);
  assert.equal(isContextWindowError("Usage limit reached. Resets in ~2h."), false);
});
