import test from "node:test";
import assert from "node:assert/strict";
import { commandName, commandRest, nextStatusMode, parseModeCommand } from "./commands.js";

test("commandName strips slash and bot suffix", () => {
  assert.equal(commandName("/task fern-sparrow"), "task");
  assert.equal(commandName("/bg@JarvisBot do work"), "bg");
  assert.equal(commandName(" plain text"), "plain");
});

test("commandRest returns the trimmed payload after the first token", () => {
  assert.equal(commandRest("/answer fern-sparrow yes, proceed"), "fern-sparrow yes, proceed");
  assert.equal(commandRest("/tasks"), "");
  assert.equal(commandRest("  /bg   audit tests  "), "audit tests");
});

test("parseModeCommand recognizes thinking and verbose toggles", () => {
  assert.deepEqual(parseModeCommand("/thinking on"), { command: "thinking", arg: "on" });
  assert.deepEqual(parseModeCommand("/verbose@JarvisBot OFF"), { command: "verbose", arg: "off" });
  assert.equal(parseModeCommand("/task fern-sparrow"), undefined);
});

test("nextStatusMode maps accepted toggle values and rejects nonsense", () => {
  assert.equal(nextStatusMode("thinking", ""), "thinking");
  assert.equal(nextStatusMode("verbose", "true"), "verbose");
  assert.equal(nextStatusMode("verbose", "stop"), "off");
  assert.equal(nextStatusMode("thinking", "maybe"), undefined);
});
