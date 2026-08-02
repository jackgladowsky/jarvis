import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const launcher = join(repoRoot, "scripts", "run-background-worker.sh");

function fingerprint(packageJson: string, lockfile: string): string {
  const packageHash = createHash("sha256").update(packageJson).digest("hex");
  const lockHash = createHash("sha256").update(lockfile).digest("hex");
  return createHash("sha256").update(`${packageHash}  package.json\n${lockHash}  pnpm-lock.yaml\n`).digest("hex");
}

test("launcher bootstraps JARVIS source while running a non-Node target worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-background-launcher-"));
  const sourceRoot = join(root, "jarvis-source");
  const worktree = join(root, "python-target");
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  const workerScript = join(root, "worker.mjs");
  const resultPath = join(root, "result.json");
  const taskId = "python-target";

  try {
    await mkdir(join(sourceRoot, "node_modules"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await mkdir(join(dataDir, "data", "background", "tasks"), { recursive: true });
    await mkdir(binDir, { recursive: true });

    const packageJson = '{"packageManager":"pnpm@10.26.2"}\n';
    const lockfile = "lockfileVersion: '9.0'\n";
    await writeFile(join(sourceRoot, "package.json"), packageJson);
    await writeFile(join(sourceRoot, "pnpm-lock.yaml"), lockfile);
    await writeFile(
      join(sourceRoot, "node_modules", ".jarvis-background-bootstrap"),
      fingerprint(packageJson, lockfile),
    );
    await writeFile(join(binDir, "pnpm"), '#!/usr/bin/env bash\n[[ "$1" == "--version" ]] && echo 10.26.2\n');
    await chmod(join(binDir, "pnpm"), 0o755);
    await writeFile(
      workerScript,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ cwd: process.cwd(), sourceRoot: process.env.JARVIS_SOURCE_ROOT }));\n`,
    );
    await writeFile(join(worktree, "pyproject.toml"), "[project]\nname = 'target'\n");

    const taskPath = join(dataDir, "data", "background", "tasks", `${taskId}.json`);
    await writeFile(taskPath, JSON.stringify({ worktree }));
    const child = spawn("bash", [launcher, taskId, workerScript], {
      env: {
        ...process.env,
        JARVIS_SOURCE_ROOT: sourceRoot,
        JARVIS_DATA_DIR: dataDir,
        NVM_DIR: join(root, "no-nvm"),
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });
    await once(child, "spawn");
    await writeFile(taskPath, JSON.stringify({ worktree, pid: child.pid }));
    const [exitCode] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), { cwd: worktree, sourceRoot });
    assert.equal(spawnSync("test", ["!", "-e", join(worktree, "node_modules")]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
