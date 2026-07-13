import assert from "node:assert/strict";
import test from "node:test";

import { compareSemver, parseSemver, requireVersionIncrease } from "./check-pr-version.mjs";

test("accepts strictly greater patch, minor, and major versions", () => {
  assert.doesNotThrow(() => requireVersionIncrease("1.2.3", "1.2.4"));
  assert.doesNotThrow(() => requireVersionIncrease("1.2.3", "1.3.0"));
  assert.doesNotThrow(() => requireVersionIncrease("1.2.3", "2.0.0"));
});

test("rejects equal and lower versions, including differing build metadata", () => {
  assert.throws(() => requireVersionIncrease("1.2.3", "1.2.3"), /strictly greater/);
  assert.throws(() => requireVersionIncrease("1.2.3", "1.2.2"), /strictly greater/);
  assert.throws(() => requireVersionIncrease("1.2.3+base", "1.2.3+candidate"), /strictly greater/);
});

test("uses SemVer prerelease precedence", () => {
  assert.doesNotThrow(() => requireVersionIncrease("1.0.0-alpha.1", "1.0.0-alpha.beta"));
  assert.doesNotThrow(() => requireVersionIncrease("1.0.0-rc.1", "1.0.0"));
  assert.throws(() => requireVersionIncrease("1.0.0", "1.0.0-rc.1"), /strictly greater/);
  assert.equal(compareSemver(parseSemver("1.0.0-alpha.2"), parseSemver("1.0.0-alpha.10")), -1);
});

test("rejects invalid SemVer versions", () => {
  assert.throws(() => parseSemver("1.2"), /not valid SemVer/);
  assert.throws(() => parseSemver("01.2.3"), /not valid SemVer/);
  assert.throws(() => parseSemver("1.2.3-01"), /leading zero/);
});
