import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
  atomicWriteJsonSync,
  withFileLock,
} from "./durable-file.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-durable-file-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("atomic writes replace complete content and preserve the existing mode", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    await writeFile(file, "old", { mode: 0o640 });
    await chmod(file, 0o640);

    await atomicWriteFile(file, "new-complete-value");

    assert.equal(await readFile(file, "utf-8"), "new-complete-value");
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  });
});

test("sync atomic writers replace files and serialize JSON", async () => {
  await withTempDir(async (dir) => {
    const textFile = join(dir, "sync.txt");
    const jsonFile = join(dir, "sync.json");
    atomicWriteFileSync(textFile, "sync-value", { mode: 0o600 });
    atomicWriteJsonSync(jsonFile, { ok: true });

    assert.equal(await readFile(textFile, "utf-8"), "sync-value");
    assert.deepEqual(JSON.parse(await readFile(jsonFile, "utf-8")), { ok: true });
  });
});

test("concurrent callers are serialized by the file lock", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "counter.json");
    await atomicWriteJson(file, { count: 0 });

    await Promise.all(
      Array.from({ length: 12 }, () =>
        withFileLock(file, async () => {
          const state = JSON.parse(await readFile(file, "utf-8")) as { count: number };
          await new Promise((resolve) => setTimeout(resolve, 2));
          await atomicWriteJson(file, { count: state.count + 1 });
        }),
      ),
    );

    assert.deepEqual(JSON.parse(await readFile(file, "utf-8")), { count: 12 });
  });
});

test("a stale lock owned by a dead process is recovered", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, createdAt: 1 }));
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);

    const value = await withFileLock(file, async () => "recovered", { staleMs: 1, timeoutMs: 1_000 });

    assert.equal(value, "recovered");
    await assert.rejects(stat(lock), { code: "ENOENT" });
  });
});

test("a complete fresh lock with a provably dead owner is recovered immediately", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ token: "fresh-dead-owner", pid: 999_999_999, createdAt: Date.now() }),
    );

    const value = await withFileLock(file, async () => "immediate", {
      staleMs: 60_000,
      timeoutMs: 500,
    });

    assert.equal(value, "immediate");
    await assert.rejects(stat(lock), { code: "ENOENT" });
  });
});

test("a complete fresh lock is recovered immediately when its PID was reused", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        token: "reused-pid-owner",
        // PID 1 is visible in the test container's procfs even though node:test
        // workers use a nested PID namespace.
        pid: 1,
        createdAt: Date.now(),
        processStart: "not-this-process-start",
      }),
    );

    const value = await withFileLock(file, async () => "reused", {
      staleMs: 60_000,
      timeoutMs: 500,
    });

    assert.equal(value, "reused");
    await assert.rejects(stat(lock), { code: "ENOENT" });
  });
});

test("a live complete owner without a provable start-time mismatch is preserved", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "live-owner", pid: process.pid, createdAt: 1 }));

    await assert.rejects(
      withFileLock(file, async () => "must-not-run", { staleMs: 1, timeoutMs: 75 }),
      /timed out waiting for state lock/,
    );
  });
});

test("a stale lock is recovered after its first reaper dies with the marker held", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead-owner", pid: 999_999_999, createdAt: 1 }));
    await writeFile(
      join(lock, "reaping.json"),
      JSON.stringify({
        token: "abandoned-reaper",
        pid: 999_999_998,
        createdAt: 1,
        processStart: "dead-process-start",
      }),
    );
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);
    await utimes(join(lock, "reaping.json"), old, old);

    const value = await withFileLock(file, async () => "recovered-after-reaper-crash", {
      staleMs: 1,
      timeoutMs: 1_000,
    });

    assert.equal(value, "recovered-after-reaper-crash");
    await assert.rejects(stat(lock), { code: "ENOENT" });
  });
});

test("concurrent stale-lock reclaimers never overlap or remove a replacement lock", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead-owner", pid: 999_999_999, createdAt: 1 }));
    const old = new Date(Date.now() - 10_000);
    await utimes(lock, old, old);

    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        withFileLock(
          file,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise((resolve) => setTimeout(resolve, 2 + (index % 3)));
            active -= 1;
          },
          { staleMs: 1, timeoutMs: 5_000 },
        ),
      ),
    );

    assert.equal(maximumActive, 1);
    await assert.rejects(stat(lock), { code: "ENOENT" });
  });
});

test("a rejected callback releases its lock for the next caller", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "state.json");
    await assert.rejects(
      withFileLock(file, async () => {
        throw new Error("expected failure");
      }),
      /expected failure/,
    );

    assert.equal(await withFileLock(file, async () => 42), 42);
  });
});
