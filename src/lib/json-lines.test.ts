import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendJsonLinesDurable, parseJsonLines, readJsonLinesRecovering } from "./json-lines.js";

test("interior JSONL corruption is rejected", () => {
  assert.throws(() => parseJsonLines('{"one":1}\n{"broken":\n{"three":3}\n'), /malformed JSONL at line 2/);
});

test("a malformed final JSONL record is quarantined and removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-jsonl-"));
  try {
    const file = join(dir, "events.jsonl");
    await writeFile(file, '{"one":1}\n{"partial":', "utf-8");

    assert.deepEqual(await readJsonLinesRecovering(file), [{ one: 1 }]);
    assert.equal(await readFile(file, "utf-8"), '{"one":1}\n');
    const quarantine = (await readdir(dir)).find((entry) => entry.startsWith("events.jsonl.corrupt-"));
    assert.ok(quarantine);
    assert.equal(await readFile(join(dir, quarantine), "utf-8"), '{"partial":\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("append normalizes an unterminated valid record and never concatenates JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-jsonl-append-"));
  try {
    const file = join(dir, "events.jsonl");
    await writeFile(file, '{"one":1}', "utf-8");

    await appendJsonLinesDurable(file, '{"two":2}\n');

    assert.equal(await readFile(file, "utf-8"), '{"one":1}\n{"two":2}\n');
    assert.deepEqual(await readJsonLinesRecovering(file), [{ one: 1 }, { two: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reader and append racing a truncated tail converge on current valid content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-jsonl-race-"));
  try {
    const file = join(dir, "events.jsonl");
    await writeFile(file, '{"one":1}\n{"partial":', "utf-8");

    await Promise.all([readJsonLinesRecovering(file), appendJsonLinesDurable(file, '{"two":2}\n')]);

    assert.deepEqual(await readJsonLinesRecovering(file), [{ one: 1 }, { two: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
