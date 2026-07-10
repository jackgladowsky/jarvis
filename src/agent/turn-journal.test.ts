import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-turn-journal-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  const journal = await import("./turn-journal.js");
  const { paths } = await import("../paths.js");
  return { dataDir, journal, paths };
}

const loaded = setup();

test.after(async () => {
  const { dataDir } = await loaded;
  await rm(dataDir, { recursive: true, force: true });
});

async function archivedTurn(id: string): Promise<Record<string, unknown>> {
  const { paths } = await loaded;
  const file = (await readdir(paths.turnJournalArchive)).find((name) => name.endsWith(`-${id}.json`));
  assert.ok(file, `archive for turn ${id} should exist`);
  return JSON.parse(await readFile(join(paths.turnJournalArchive, file), "utf-8")) as Record<string, unknown>;
}

test("a crash after tool start is recovered as outcome-unknown before the next turn", async () => {
  const { journal } = await loaded;
  const first = await journal.beginChatTurn(101, "session-a", "change production state", 0);
  await journal.recordChatToolStart(first.current, "bash");

  // A second begin simulates process recovery: the first turn never committed.
  const recovered = await journal.beginChatTurn(101, "session-a", "did that finish?", 0);
  assert.equal(recovered.interrupted?.id, first.current.id);
  assert.equal(recovered.interrupted?.tool_started, true);
  assert.deepEqual(recovered.interrupted?.tool_names, ["bash"]);
  assert.equal(journal.interruptedTurnHasReplayRisk(recovered.interrupted), true);
  assert.match(journal.renderInterruptedTurnWarning(recovered.interrupted!), /outcome is unknown/i);
  assert.match(journal.renderInterruptedTurnWarning(recovered.interrupted!), /bash/);

  await journal.finishChatTurn(recovered.current, "committed");
  assert.equal((await archivedTurn(first.current.id)).status, "interrupted");
});

test("a crash after visible output records the replay boundary before recovery", async () => {
  const { journal } = await loaded;
  const first = await journal.beginChatTurn(202, "session-b", "answer me", 0);
  await journal.recordChatVisibleOutput(first.current);

  const recovered = await journal.beginChatTurn(202, "session-b", "next", 0);
  assert.equal(recovered.interrupted?.visible_output, true);
  assert.equal(journal.interruptedTurnHasReplayRisk(recovered.interrupted), true);
  assert.match(journal.renderInterruptedTurnWarning(recovered.interrupted!), /visible or side-effecting boundary/i);

  await journal.finishChatTurn(recovered.current, "committed");
});

test("committing a durably persisted turn prevents a false interruption on the next turn", async () => {
  const { journal, paths } = await loaded;
  const first = await journal.beginChatTurn(303, "session-c", "ordinary prompt", 1);
  await journal.finishChatTurn(first.current, "committed");

  const next = await journal.beginChatTurn(303, "session-c", "follow-up", 0);
  assert.equal(next.interrupted, undefined);
  const committed = await archivedTurn(first.current.id);
  assert.equal(committed.status, "committed");
  assert.equal(committed.prompt_bytes, Buffer.byteLength("ordinary prompt"));
  assert.equal(committed.image_count, 1);

  await journal.finishChatTurn(next.current, "cancelled", "test cleanup");
  assert.equal((await readdir(paths.turnJournalActive)).filter((name) => name.endsWith(".json")).length, 0);
});

test("a side-effect-free interrupted turn gets a distinct non-boundary recovery note", async () => {
  const { journal } = await loaded;
  const first = await journal.beginChatTurn(404, "session-d", "prompt before provider crash", 0);

  const recovered = await journal.beginChatTurn(404, "session-d", "retry", 0);
  assert.equal(recovered.interrupted?.id, first.current.id);
  assert.equal(journal.interruptedTurnHasReplayRisk(recovered.interrupted), false);
  const warning = journal.renderInterruptedTurnWarning(recovered.interrupted!);
  assert.match(warning, /no tool-start or visible-output boundary was durably recorded/i);
  assert.doesNotMatch(warning, /an externally visible or side-effecting boundary was crossed/i);

  await journal.finishChatTurn(recovered.current, "committed");
});

test("a side-effect-free failed recovery turn does not consume an earlier risky warning", async () => {
  const { journal } = await loaded;
  const risky = await journal.beginChatTurn(505, "session-e", "perform one external action", 0);
  await journal.recordChatToolStart(risky.current, "bash");

  const failedRecovery = await journal.beginChatTurn(505, "session-e", "check whether it finished", 0);
  assert.deepEqual(
    failedRecovery.interruptions.map((turn) => turn.id),
    [risky.current.id],
  );
  await journal.finishChatTurn(failedRecovery.current, "failed", "provider unavailable before any boundary");

  const retriedRecovery = await journal.beginChatTurn(505, "session-e", "check again", 0);
  assert.deepEqual(
    retriedRecovery.interruptions.map((turn) => turn.id),
    [risky.current.id],
  );
  assert.match(journal.renderInterruptedTurnWarning(retriedRecovery.interrupted!), /outcome is unknown/i);
  await journal.finishChatTurn(retriedRecovery.current, "committed");

  const acknowledged = await journal.beginChatTurn(505, "session-e", "ordinary follow-up", 0);
  assert.equal(acknowledged.interrupted, undefined);
  assert.deepEqual(acknowledged.interruptions, []);
  await journal.finishChatTurn(acknowledged.current, "cancelled", "test cleanup");
});
