import test from "node:test";
import assert from "node:assert/strict";
import { assessWorkbenchRequest, assertReadOnlyWorkbenchAction, validateWorkbenchUrl } from "./safety.js";

test("validateWorkbenchUrl allows public http(s) URLs", () => {
  const result = validateWorkbenchUrl("https://example.com/path?q=1");
  assert.equal(result.allowed, true);
  assert.equal(result.url?.hostname, "example.com");
});

test("validateWorkbenchUrl blocks local and private targets", () => {
  for (const url of [
    "file:///etc/passwd",
    "http://localhost:3000",
    "http://app.local",
    "http://127.0.0.1",
    "http://10.0.0.4",
    "http://172.16.0.1",
    "http://192.168.1.10",
    "http://[::1]/",
  ]) {
    assert.equal(validateWorkbenchUrl(url).allowed, false, url);
  }
});

test("assessWorkbenchRequest flags hard-approval categories", () => {
  const risky = assessWorkbenchRequest("Open DoorDash, place the order, then book me an Uber and send the ETA.");
  assert.equal(risky.approvalRequired, true);
  assert.match(risky.reason ?? "", /Hard approval required/);
  assert.ok(risky.matchedTerms.includes("order"));
  assert.ok(risky.matchedTerms.includes("booking"));
  assert.ok(risky.matchedTerms.includes("send/post"));

  const safe = assessWorkbenchRequest("Open Wikipedia and summarize the article.");
  assert.equal(safe.approvalRequired, false);
});

test("assertReadOnlyWorkbenchAction blocks side-effect actions", () => {
  assert.equal(assertReadOnlyWorkbenchAction("open_url").allowed, true);
  assert.equal(assertReadOnlyWorkbenchAction("click").allowed, false);
  assert.equal(assertReadOnlyWorkbenchAction("submit").allowed, false);
});
