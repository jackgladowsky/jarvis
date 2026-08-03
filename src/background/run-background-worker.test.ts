import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const launcher = join(repoRoot, "scripts", "run-background-worker.sh");

test("launcher starts a deployed worker artifact without bootstrapping a non-Node target", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-background-launcher-"));
  const worktree = join(root, "python-target");
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  const workerArtifact = join(root, "worker.mjs");
  const resultPath = join(root, "result.json");
  const taskId = "python-target";

  try {
    await mkdir(worktree, { recursive: true });
    await mkdir(join(dataDir, "data", "background", "tasks"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    // A target repo may be Python-only. Any launcher attempt to use pnpm must
    // fail; the deployed Node runtime is passed explicitly instead.
    await writeFile(join(worktree, "pyproject.toml"), "[project]\nname = 'target'\n");
    await writeFile(join(binDir, "pnpm"), '#!/usr/bin/env bash\necho "pnpm must not run" >&2\nexit 99\n', {
      mode: 0o755,
    });
    await writeFile(
      workerArtifact,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ cwd: process.cwd(), sourceRoot: process.env.JARVIS_SOURCE_ROOT }));\n`,
    );

    const taskPath = join(dataDir, "data", "background", "tasks", `${taskId}.json`);
    await writeFile(taskPath, JSON.stringify({ worktree }));
    const child = spawn("bash", [launcher, taskId, process.execPath, workerArtifact], {
      cwd: worktree,
      env: {
        ...process.env,
        JARVIS_SOURCE_ROOT: join(root, "deployed-jarvis"),
        JARVIS_DATA_DIR: dataDir,
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });
    await once(child, "spawn");
    await writeFile(taskPath, JSON.stringify({ worktree, pid: child.pid }));
    const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
      cwd: worktree,
      sourceRoot: join(root, "deployed-jarvis"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher records a durable failure when its deployed artifact is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-background-launcher-failure-"));
  const worktree = join(root, "target");
  const dataDir = join(root, "data");
  const taskId = "missing-artifact";
  const taskPath = join(dataDir, "data", "background", "tasks", `${taskId}.json`);
  const failurePath = join(dataDir, "data", "background", "bootstrap-failures", `${taskId}.json`);

  try {
    await mkdir(worktree, { recursive: true });
    await mkdir(join(dataDir, "data", "background", "tasks"), { recursive: true });
    await writeFile(taskPath, JSON.stringify({ worktree }));
    const child = spawn("bash", [launcher, taskId, process.execPath, join(root, "missing-worker.mjs")], {
      cwd: worktree,
      env: { ...process.env, JARVIS_DATA_DIR: dataDir },
    });
    await once(child, "spawn");
    await writeFile(taskPath, JSON.stringify({ worktree, pid: child.pid }));
    const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    assert.equal(exitCode, 1);
    const failure = JSON.parse(await readFile(failurePath, "utf8")) as { error: string };
    assert.match(failure.error, /launcher failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
