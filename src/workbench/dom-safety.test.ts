import assert from "node:assert/strict";
import test from "node:test";
import { assessResolvedElement, type ResolvedElementSemantics } from "./dom-safety.js";

function element(overrides: Partial<ResolvedElementSemantics> = {}): ResolvedElementSemantics {
  return {
    tagName: "button",
    role: "button",
    type: "button",
    text: "More information",
    ariaLabel: "",
    title: "",
    value: "",
    href: "",
    formAction: "",
    formMethod: "",
    insideForm: false,
    ...overrides,
  };
}

test("resolved DOM semantics defeat benign-selector bypasses", () => {
  const hiddenRisk = element({ text: "Delete account" });
  assert.equal(assessResolvedElement(hiddenRisk, false).allowed, false);
  assert.equal(assessResolvedElement(hiddenRisk, true).allowed, true);

  const implicitSubmit = element({ type: "", insideForm: true, formAction: "https://example.com/send" });
  assert.equal(assessResolvedElement(implicitSubmit, false).allowed, false);
  assert.equal(assessResolvedElement(implicitSubmit, true).allowed, true);
});

test("resolved credentials and purchases remain hard blocked with capability", () => {
  assert.equal(assessResolvedElement(element({ ariaLabel: "Password" }), true).allowed, false);
  assert.equal(assessResolvedElement(element({ text: "Buy now" }), true).allowed, false);
});
