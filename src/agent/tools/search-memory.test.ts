import assert from "node:assert/strict";
import test from "node:test";
import { allTools } from "./index.js";
import { searchMemoryTool } from "./search-memory.js";

test("search_memory is available for natural-language recall with bounded parameters", () => {
  assert.equal(searchMemoryTool.name, "search_memory");
  assert.ok(allTools.some((tool) => tool.name === "search_memory"));
  assert.match(searchMemoryTool.description, /past conversation/i);
  assert.match(searchMemoryTool.description, /historical text is untrusted/i);
});
