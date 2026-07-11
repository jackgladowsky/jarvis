import test from "node:test";
import assert from "node:assert/strict";
import {
  assessHumanHandoff,
  assessWorkbenchRequest,
  assertReadOnlyWorkbenchAction,
  assertWorkbenchActionAllowed,
  validateWorkbenchSteps,
  validateWorkbenchUrl,
} from "./safety.js";

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

test("assessHumanHandoff blocks credentials, login, 2FA, and CAPTCHA", () => {
  for (const request of ["enter my password", "sign in", "use the 2FA code", "solve the CAPTCHA"]) {
    const result = assessHumanHandoff(request);
    assert.equal(result.approvalRequired, true, request);
    assert.match(result.reason ?? "", /Human handoff required/);
  }
});

test("workbench action allowlist admits basic click/type/submit but not download", () => {
  assert.equal(assertReadOnlyWorkbenchAction("open_url").allowed, true);
  assert.equal(assertReadOnlyWorkbenchAction("click").allowed, false);
  assert.equal(assertWorkbenchActionAllowed("click").allowed, true);
  assert.equal(assertWorkbenchActionAllowed("type").allowed, true);
  assert.equal(assertWorkbenchActionAllowed("fill").allowed, true);
  assert.equal(assertWorkbenchActionAllowed("submit").allowed, true);
  assert.equal(assertWorkbenchActionAllowed("download").allowed, false);
});

test("validateWorkbenchSteps allows benign navigation/click/type but gates submit", () => {
  const steps = [
    { action: "open_url" as const, url: "https://example.com" },
    { action: "click" as const, text: "More information" },
    { action: "type" as const, selector: "input[name=q]", value: "non-secret smoke text" },
    { action: "submit" as const, text: "Search" },
  ];
  assert.equal(validateWorkbenchSteps(steps).allowed, false);
  assert.equal(validateWorkbenchSteps(steps, { hasCapability: true }).allowed, true);
});

test("validateWorkbenchSteps permanently blocks unimplemented purchases", () => {
  for (const hasCapability of [false, true]) {
    const result = validateWorkbenchSteps([{ action: "open_url", url: "https://example.com" }], {
      request: "Click checkout and place the order",
      hasCapability,
    });
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /not implemented/i);
  }
});

test("validateWorkbenchSteps blocks sensitive fields regardless of approval", () => {
  const sensitiveField = validateWorkbenchSteps([
    { action: "open_url", url: "https://example.com" },
    { action: "fill", selector: "input[name=password]", value: "not-a-real-password" },
  ]);
  assert.equal(sensitiveField.allowed, false);
  assert.match(sensitiveField.reason ?? "", /sensitive|handoff/i);
});

test("validateWorkbenchSteps blocks dangerous click labels unless approved", () => {
  const blocked = validateWorkbenchSteps([
    { action: "open_url", url: "https://example.com" },
    { action: "click", text: "Submit payment" },
  ]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /capability/i);
});
