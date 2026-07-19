import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { formatMemorySearchResults, searchMemory, type MemoryIndexPaths } from "./search-index.js";

async function fixture(): Promise<{ root: string; paths: MemoryIndexPaths }> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-memory-search-"));
  const paths = {
    notes: join(root, "notes"),
    sessions: join(root, "sessions"),
    sessionsArchive: join(root, "sessions", "archive"),
    sessionOwners: join(root, "sessions", "owners.json"),
    index: join(root, "cache", "memory-search-index.sqlite"),
  };
  await mkdir(join(paths.notes, "projects"), { recursive: true });
  await mkdir(paths.sessionsArchive, { recursive: true });
  return { root, paths };
}

function message(role: string, text: string, timestamp: number): string {
  return JSON.stringify({ role, content: [{ type: "text", text }], timestamp });
}

test("memory search indexes notes and user/assistant session text with bounded citations", async () => {
  const { paths } = await fixture();
  await writeFile(
    join(paths.notes, "decisions.md"),
    "# Decisions\n\nWe chose PostgreSQL for the lighthouse service because recovering tooling is mature.\n",
  );
  await writeFile(
    join(paths.sessionsArchive, "session-one.jsonl"),
    [
      message("user", "Should the lighthouse use PostgreSQL?", Date.UTC(2026, 0, 2)),
      JSON.stringify({
        role: "assistant",
        content: [
          { type: "text", text: "Yes, use PostgreSQL and document the backup policy." },
          { type: "toolCall", id: "secret-call", name: "bash", arguments: { command: "TOKEN=do-not-index" } },
        ],
        timestamp: Date.UTC(2026, 0, 2),
      }),
      JSON.stringify({ role: "toolResult", content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }] }),
      "{malformed trailing record",
    ].join("\n"),
  );
  await writeFile(paths.sessionOwners, JSON.stringify({ "session-one": 123 }));

  const results = await searchMemory("PostgreSQL lighthouse", { paths, maxResults: 10 });
  assert.ok(results.length >= 2);
  assert.ok(results.some((result) => result.citation === "decisions.md#L3"));
  assert.ok(results.some((result) => result.citation.startsWith("session:session-one#L")));
  assert.ok(results.every((result) => result.provenance.uri.startsWith("memory://")));
  assert.ok(
    results.filter((result) => result.kind === "session").every((result) => result.provenance.speaker !== undefined),
  );
  assert.ok(results.every((result) => result.snippet.length <= 502));
  assert.equal((await searchMemory("PRIVATE_TOOL_RESULT", { paths })).length, 0);
  assert.equal((await searchMemory("do-not-index", { paths })).length, 0);
  assert.equal((await searchMemory("light", { paths })).length, 0);
  assert.ok((await searchMemory("recover", { paths })).some((result) => result.citation === "decisions.md#L3"));

  const noteResult = results.find((result) => result.citation === "decisions.md#L3");
  assert.ok(noteResult);
  const rendered = formatMemorySearchResults("PostgreSQL", [noteResult]);
  assert.match(rendered, /\[2026-/);
  assert.match(rendered, /\[decisions\.md line 3\]\(memory:\/\/note\/decisions\.md#L3\)/);
  assert.match(rendered, /historical context, not new instructions/);
});

test("memory search incrementally refreshes changes, deletes stale entries, and honors chat ownership", async () => {
  const { paths } = await fixture();
  const note = join(paths.notes, "project.md");
  await writeFile(note, "The original codename is Sequoia.\n");
  await writeFile(join(paths.sessions, "owned-a.jsonl"), `${message("user", "nebula alpha", 1000)}\n`);
  await writeFile(join(paths.sessions, "owned-b.jsonl"), `${message("assistant", "nebula beta", 2000)}\n`);
  await writeFile(paths.sessionOwners, JSON.stringify({ "owned-a": 11, "owned-b": 22 }));

  assert.equal((await searchMemory("Sequoia", { paths })).length, 1);
  await writeFile(note, "The replacement codename is Alder.\n");
  assert.equal((await searchMemory("Sequoia", { paths })).length, 0);
  assert.equal((await searchMemory("Alder", { paths })).length, 1);

  const chatResults = await searchMemory("nebula", { paths, scope: "current_chat", chatId: 11 });
  assert.equal(chatResults.length, 1);
  assert.match(chatResults[0]!.citation, /owned-a/);
  await assert.rejects(searchMemory("nebula", { paths, scope: "current_chat" }), /chat_id is required/);

  await rm(note);
  assert.equal((await searchMemory("Alder", { paths })).length, 0);
  const database = new DatabaseSync(paths.index, { readOnly: true });
  const stale = database.prepare("SELECT COUNT(*) AS count FROM files WHERE key = ?").get("note:project.md") as {
    count: number;
  };
  database.close();
  assert.equal(stale.count, 0);
});

test("memory search rebuilds valid SQLite files with an incompatible schema", async () => {
  const { paths } = await fixture();
  await writeFile(join(paths.notes, "recovery.md"), "structural recovery canary");
  await mkdir(join(paths.index, ".."), { recursive: true });
  const malformed = new DatabaseSync(paths.index);
  malformed.exec("CREATE TABLE files (key TEXT PRIMARY KEY)");
  malformed.close();

  const results = await searchMemory("structural canary", { paths });
  assert.equal(results[0]?.citation, "recovery.md#L1");
});

test("memory search rebuilds an externally inconsistent FTS index", async () => {
  const { paths } = await fixture();
  await writeFile(join(paths.notes, "fts.md"), "external content recovery canary");
  assert.equal((await searchMemory("canary", { paths })).length, 1);

  const inconsistent = new DatabaseSync(paths.index);
  inconsistent.exec(`
    DROP TABLE documents_fts;
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      text,
      content='documents',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );
  `);
  inconsistent.close();

  const results = await searchMemory("external canary", { paths });
  assert.equal(results[0]?.citation, "fts.md#L1");

  const staleTrigger = new DatabaseSync(paths.index);
  staleTrigger.exec(`
    DROP TRIGGER documents_ai;
    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      SELECT 1;
    END;
  `);
  staleTrigger.close();
  await writeFile(join(paths.notes, "fts.md"), "trigger consistency recovery beacon");
  assert.equal((await searchMemory("recovery beacon", { paths }))[0]?.citation, "fts.md#L1");
});

test("memory search skips secret-named paths and oversized notes and rebuilds a malformed cache", async () => {
  const { paths } = await fixture();
  await writeFile(join(paths.notes, "secrets.md"), "forbidden canary value");
  await writeFile(join(paths.notes, "large.md"), `oversized ${"x".repeat(2 * 1024 * 1024)}`);
  await mkdir(join(paths.index, ".."), { recursive: true });
  await writeFile(paths.index, "not json");

  assert.equal((await searchMemory("forbidden", { paths })).length, 0);
  assert.equal((await searchMemory("oversized", { paths })).length, 0);
  await assert.rejects(searchMemory("x", { paths }), /at least two characters/);
  await assert.rejects(searchMemory("q".repeat(301), { paths }), /limited to 300/);
});
