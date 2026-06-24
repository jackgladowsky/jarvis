import test from "node:test";
import assert from "node:assert/strict";
import { clipVisibleText, renderWorkbenchResult, type WorkbenchPageSnapshot } from "./render.js";

test("clipVisibleText normalizes and truncates visible text", () => {
  assert.deepEqual(clipVisibleText(" hello   world\n\n\nagain ", 100), {
    text: "hello world\n\nagain",
    truncated: false,
  });

  const clipped = clipVisibleText("abcdef", 4);
  assert.equal(clipped.text, "abc…");
  assert.equal(clipped.truncated, true);
});

test("renderWorkbenchResult returns safe paths/text, not binary data", () => {
  const snapshot: WorkbenchPageSnapshot = {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    title: "Example Domain",
    visibleText: "Example Domain\nThis domain is for use in illustrative examples.",
    screenshotPath: "/home/jack/.jarvis/data/workbench/screenshots/test.png",
    artifactPath: "/home/jack/.jarvis/data/workbench/artifacts/test.json",
    capturedAt: "2026-01-01T00:00:00.000Z",
    steps: [
      {
        index: 1,
        action: "open_url",
        target: "https://example.com/",
        startedUrl: "about:blank",
        endedUrl: "https://example.com/",
      },
    ],
  };

  const rendered = renderWorkbenchResult(snapshot);
  assert.match(rendered, /Example Domain/);
  assert.match(rendered, /screenshots\/test\.png/);
  assert.match(rendered, /Steps:/);
  assert.doesNotMatch(rendered, /data:image|base64/i);
});
