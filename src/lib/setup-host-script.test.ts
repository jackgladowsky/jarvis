import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("bash", [join(repo, script), ...args], { cwd: repo, env });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

test("setup-host preserves content and tightens the complete data tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-setup-test-"));
  const data = join(root, "data");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "pnpm"),
    '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo 10.26.2; fi\nexit 0\n',
    { mode: 0o755 },
  );
  const env = { ...process.env, HOME: root, JARVIS_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}` };

  try {
    const first = await run("scripts/setup-host.sh", [], env);
    assert.equal(first.code, 0, first.output);
    await writeFile(join(data, "config.yaml"), "owner configuration\n");
    await mkdir(join(data, "data", "private"), { recursive: true });
    await writeFile(join(data, "data", "private", "session.jsonl"), "private\n");
    await chmod(data, 0o755);
    await chmod(join(data, "config.yaml"), 0o644);

    const second = await run("scripts/setup-host.sh", [], env);
    assert.equal(second.code, 0, second.output);
    assert.equal(await readFile(join(data, "config.yaml"), "utf-8"), "owner configuration\n");
    assert.equal((await stat(data)).mode & 0o777, 0o700);
    assert.equal((await stat(join(data, "data", "private"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(data, "config.yaml"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(data, "data", "private", "session.jsonl"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer dry-run is noninteractive and does not create host state", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-install-test-"));
  const data = join(root, "data");
  try {
    const result = await run(
      "scripts/install.sh",
      ["--dry-run", "--yes", "--skip-systemd", "--install-dir", repo, "--data-dir", data],
      { ...process.env, HOME: root },
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /dry-run.*setup-host/);
    await assert.rejects(stat(data), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
