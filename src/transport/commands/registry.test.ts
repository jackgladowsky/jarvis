import test from "node:test";
import assert from "node:assert/strict";
import "./handlers/index.js";
import { botMenuCommands, findCommand, getRegistry, renderHelp } from "./registry.js";

test("registry is non-empty after handlers/index loads", () => {
  const names = getRegistry().map((def) => def.name);
  assert.ok(names.length > 0, "registry should have entries");
  assert.ok(names.includes("version"), "version should be registered");
  assert.ok(names.includes("status"), "status should be registered");
  assert.ok(names.includes("usage"), "usage should be registered");
  assert.ok(names.includes("model"), "model should be registered");
  assert.ok(names.includes("help"), "help should be registered");
});

test("findCommand matches canonical slash names", () => {
  const match = findCommand("/version");
  assert.ok(match, "/version should match");
  assert.equal(match!.def.name, "version");
  assert.equal(match!.parsed.args, "");
  assert.deepEqual(match!.parsed.parts, []);
});

test("findCommand strips bot suffix and parses args", () => {
  const match = findCommand("/model@jarvisbot openai/gpt-4o");
  assert.ok(match, "should match with bot suffix");
  assert.equal(match!.def.name, "model");
  assert.equal(match!.parsed.args, "openai/gpt-4o");
  assert.deepEqual(match!.parsed.parts, ["openai/gpt-4o"]);
});

test("findCommand resolves aliases", () => {
  const match = findCommand("/bg hello world");
  assert.ok(match, "/bg should resolve");
  assert.equal(match!.def.name, "bg");
  assert.equal(match!.parsed.args, "hello world");
});

test("findCommand returns undefined for plain text", () => {
  assert.equal(findCommand("hello world"), undefined);
  assert.equal(findCommand(""), undefined);
  // Leading whitespace is trimmed before matching, so this resolves.
  assert.ok(findCommand(" /version"));
});

test("findCommand returns undefined for unknown commands", () => {
  assert.equal(findCommand("/nope"), undefined);
  assert.equal(findCommand("/not_a_real_command"), undefined);
});

test("renderHelp groups commands by category", () => {
  const out = renderHelp();
  assert.match(out, /^JARVIS commands/);
  assert.match(out, /\/version\b/);
  assert.match(out, /\/help\b/);
  assert.match(out, /— Session —/);
  assert.match(out, /— Status —/);
  assert.match(out, /— Background —/);
});

test("renderHelp filters by category", () => {
  const out = renderHelp("Status");
  assert.match(out, /\/version/);
  assert.match(out, /\/usage/);
  assert.doesNotMatch(out, /\/model —/, "should not include non-Status commands");
  assert.doesNotMatch(out, /— Background —/, "should not include other categories");
});

test("renderHelp handles missing categories gracefully", () => {
  const out = renderHelp("NotARealCategory");
  assert.match(out, /No commands in category 'NotARealCategory'/);
});

test("botMenuCommands respects Telegram limits", () => {
  const cmds = botMenuCommands();
  assert.ok(cmds.length > 0);
  assert.ok(cmds.length <= 30, "menu should cap at 30 commands");
  for (const c of cmds) {
    assert.ok(c.command.length <= 32, `${c.command} name must be ≤32 chars`);
    assert.ok(c.description.length <= 256, `${c.command} desc must be ≤256 chars`);
  }
});

test("botMenuCommands can override cap", () => {
  const cmds = botMenuCommands(5);
  assert.equal(cmds.length, 5);
});

test("every registered name and alias is unique", () => {
  const seen = new Set<string>();
  for (const def of getRegistry()) {
    assert.ok(!seen.has(def.name), `duplicate name: ${def.name}`);
    seen.add(def.name);
    for (const alias of def.aliases ?? []) {
      assert.ok(!seen.has(alias), `alias ${alias} clashes with name`);
      seen.add(alias);
    }
  }
});
