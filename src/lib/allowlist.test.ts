import assert from "node:assert/strict";
import test from "node:test";
import { parseAllowedUserIds } from "./allowlist.js";

test("parseAllowedUserIds accepts exact positive integer IDs", () => {
  assert.deepEqual([...parseAllowedUserIds("123, 456,123")], [123, 456]);
});

test("parseAllowedUserIds rejects partial, empty, negative, and unsafe IDs", () => {
  for (const input of ["", "123abc", "-1", "0", "9007199254740992"]) {
    assert.throws(() => parseAllowedUserIds(input), /Telegram|TELEGRAM/);
  }
});
