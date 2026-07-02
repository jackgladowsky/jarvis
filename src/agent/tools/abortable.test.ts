import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { makeAbortableTool } from "./abortable.js";

const schema = Type.Object({});

test("abortable tool wrapper rejects a hanging tool on abort", async () => {
  let stillRunning = true;
  const hangingTool: AgentTool<typeof schema> = {
    name: "hang",
    label: "Hang",
    description: "Never resolves unless the wrapper aborts.",
    parameters: schema,
    execute: async () => {
      await new Promise(() => undefined);
      stillRunning = false;
      return { content: [{ type: "text" as const, text: "done" }], details: {} };
    },
  };

  const controller = new AbortController();
  const wrapped = makeAbortableTool(hangingTool);
  const promise = wrapped.execute("tool-call", {}, controller.signal);
  controller.abort();

  await assert.rejects(promise, /aborted/);
  assert.equal(stillRunning, true, "wrapper cannot stop arbitrary ignored work; it only makes the agent stop waiting");
});
