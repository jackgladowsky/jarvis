import test from "node:test";
import assert from "node:assert/strict";
import { formatVersionInfo, isSemver, renderVersionBlock, type VersionInfo } from "./version.js";

test("isSemver accepts release and prerelease semver strings", () => {
  for (const version of ["0.0.0", "1.2.3", "2.4.0-rc.1+build.9"]) {
    assert.equal(isSemver(version), true, version);
  }
  for (const version of ["latest", "1", "1.2", "v1.2.3"]) {
    assert.equal(isSemver(version), false, version);
  }
});

test("formatVersionInfo renders compact release metadata", () => {
  const info: VersionInfo = {
    name: "jarvis",
    version: "1.2.3",
    commit: "abc1234",
    branch: "main",
    dirty: false,
  };

  assert.equal(formatVersionInfo(info), "jarvis v1.2.3 • abc1234 • main • clean");
  assert.match(renderVersionBlock(info), /jarvis v1.2.3/);
  assert.match(renderVersionBlock(info), /Commit: abc1234/);
});
