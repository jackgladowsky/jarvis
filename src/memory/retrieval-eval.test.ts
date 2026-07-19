import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { retrievalRegressionCorpus } from "./retrieval-eval.fixtures.js";
import { evaluateRetrieval } from "./retrieval-eval.js";
import { searchMemory, type MemoryIndexPaths } from "./search-index.js";

async function installRegressionCorpus(): Promise<MemoryIndexPaths> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-memory-eval-"));
  const paths: MemoryIndexPaths = {
    notes: join(root, "notes"),
    sessions: join(root, "sessions"),
    sessionsArchive: join(root, "sessions", "archive"),
    sessionOwners: join(root, "sessions", "owners.json"),
    index: join(root, "cache", "memory-search-index.sqlite"),
  };
  await mkdir(paths.sessionsArchive, { recursive: true });
  for (const note of retrievalRegressionCorpus.notes) {
    const path = join(paths.notes, note.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, note.text);
  }
  const owners: Record<string, number> = {};
  for (const session of retrievalRegressionCorpus.sessions) {
    owners[session.id] = session.chatId;
    await writeFile(
      join(paths.sessionsArchive, `${session.id}.jsonl`),
      session.messages
        .map(({ role, text, timestamp }) => JSON.stringify({ role, content: [{ type: "text", text }], timestamp }))
        .join("\n"),
    );
  }
  await writeFile(paths.sessionOwners, JSON.stringify(owners));
  return paths;
}

test("labeled lexical retrieval regression covers durable notes and session history", async () => {
  const paths = await installRegressionCorpus();
  const metrics = await evaluateRetrieval(
    retrievalRegressionCorpus.cases,
    async (query, k) => searchMemory(query, { paths, maxResults: k }),
    3,
  );

  assert.equal(metrics.cases, 3);
  assert.equal(metrics.bySource.note.cases, 2);
  assert.equal(metrics.bySource.session.cases, 1);
  assert.equal(metrics.recallAtK, 1);
  assert.equal(metrics.meanReciprocalRank, 1);
  assert.equal(metrics.meanAveragePrecision, 1);
  assert.equal(metrics.precisionAtK, 4 / 9);
});

test("retrieval evaluator reports ranking regressions with standard precision and relevance metrics", async () => {
  const metrics = await evaluateRetrieval(
    [{ id: "ranking", query: "q", relevantCitations: ["a", "c"], source: "mixed" }],
    async () => [{ citation: "x" }, { citation: "a" }, { citation: "c" }],
    3,
  );
  assert.deepEqual(metrics.perCase[0], {
    id: "ranking",
    hits: 2,
    precisionAtK: 2 / 3,
    recallAtK: 1,
    reciprocalRank: 1 / 2,
    averagePrecision: (1 / 2 + 2 / 3) / 2,
  });
});
