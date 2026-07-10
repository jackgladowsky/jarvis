import test from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(repoRoot, "scripts/safe-deploy.sh");

test("self deploy refuses background workers before push or activation", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "jarvis-self-deploy-test-"));
  try {
    const result = spawnSync("bash", [script, "--self-main"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        JARVIS_DATA_DIR: dataDir,
        JARVIS_BACKGROUND_BOOTSTRAPPED: "1",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden from a background worker/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Publishing exact verified SHA|Activating source/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("remote deploy also refuses background worktree environments", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "jarvis-remote-deploy-test-"));
  try {
    const result = spawnSync("bash", [script], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        JARVIS_DATA_DIR: dataDir,
        JARVIS_BACKGROUND_WORKTREE: "/tmp/background-worktree",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden from a background worker/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Publishing exact verified SHA|Activating source/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  "self deploy pushes, activates, and reuses its exact-SHA cache",
  { skip: process.platform !== "linux", timeout: 60_000 },
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "jarvis-self-deploy-integration-"));
    const checkout = join(root, "checkout");
    const remote = join(root, "origin.git");
    const dataDir = join(root, "data");
    const binDir = join(root, "bin");
    const pnpmLog = join(root, "pnpm.log");
    const run = (command: string, args: string[], cwd = checkout, env: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync(command, args, {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, ...env },
      });
      assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
      return result.stdout.trim();
    };

    try {
      await mkdir(join(checkout, "scripts"), { recursive: true });
      await mkdir(join(checkout, "prompts"), { recursive: true });
      await mkdir(binDir, { recursive: true });
      await cp(script, join(checkout, "scripts/safe-deploy.sh"));
      await writeFile(join(checkout, "package.json"), '{"packageManager":"pnpm@10.26.2"}\n');
      await writeFile(join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFile(join(checkout, "config.yaml.example"), "agent: {}\n");
      await writeFile(join(checkout, "prompts/system.md.example"), "test prompt\n");
      await writeFile(
        join(checkout, ".gitignore"),
        "dist/\nnode_modules/\n.jarvis-node-modules-previous-*/\n.jarvis-dist-next-*/\n.jarvis-dist-previous-*/\n",
      );
      await writeFile(
        join(binDir, "pnpm"),
        `#!/usr/bin/env bash\nset -e\necho "$*" >> "$FAKE_PNPM_LOG"\nif [[ "\${1:-}" == "--version" ]]; then echo 10.26.2; exit 0; fi\nif [[ "\${1:-}" == "install" ]]; then mkdir -p node_modules; exit 0; fi\nif [[ "\${1:-}" == "run" && "\${2:-}" == "build" ]]; then\n  mkdir -p dist\n  printf '%s\\n' "module.exports = 'verified-release';" > dist/index.js\n  printf '%s\\n' "const test = require('node:test'); test('release smoke', () => {});" > dist/smoke.test.js\n  exit 0\nfi\nexit 2\n`,
      );
      await writeFile(
        join(binDir, "sudo"),
        '#!/usr/bin/env bash\nif [[ "$*" == *"systemctl show"* ]]; then echo loaded; fi\nexit 0\n',
      );
      await chmod(join(binDir, "pnpm"), 0o755);
      await chmod(join(binDir, "sudo"), 0o755);

      run("git", ["init", "--bare", remote], root);
      run("git", ["init", "-b", "main"]);
      run("git", ["config", "user.email", "test@example.com"]);
      run("git", ["config", "user.name", "Test"]);
      run("git", ["add", "."]);
      run("git", ["commit", "-m", "initial"]);
      run("git", ["remote", "add", "origin", remote]);
      run("git", ["push", "-u", "origin", "main"]);
      await writeFile(join(checkout, "change.txt"), "reviewed change\n");
      run("git", ["add", "change.txt"]);
      run("git", ["commit", "-m", "reviewed change"]);
      const sha = run("git", ["rev-parse", "HEAD"]);
      await mkdir(join(checkout, "dist"), { recursive: true });
      await writeFile(join(checkout, "dist/index.js"), "module.exports = 'old-release';\n");

      const deployEnv = {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        JARVIS_DATA_DIR: dataDir,
        JARVIS_DEPLOY_RESTART_DELAY_SECONDS: "0",
        FAKE_PNPM_LOG: pnpmLog,
      };
      const first = run("bash", [join(checkout, "scripts/safe-deploy.sh"), "--self-main"], checkout, deployEnv);
      assert.match(first, /Publishing exact verified SHA/);
      assert.equal(run("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], root), sha);
      assert.match(await readFile(join(checkout, "dist/index.js"), "utf-8"), /verified-release/);
      assert.equal(JSON.parse(await readFile(join(dataDir, "data/deploy/pending.json"), "utf-8")).new_rev, sha);

      const second = run("bash", [join(checkout, "scripts/safe-deploy.sh"), "--self-main"], checkout, deployEnv);
      assert.match(second, /Using verified deploy cache/);
      const builds = (await readFile(pnpmLog, "utf-8")).split("\n").filter((line) => line === "run build");
      assert.equal(builds.length, 1);

      await writeFile(join(checkout, "node_modules/old-dependency-sentinel"), "old dependencies\n");
      await writeFile(join(checkout, "package.json"), '{"packageManager":"pnpm@10.26.2","version":"1.0.1"}\n');
      run("git", ["add", "package.json"]);
      run("git", ["commit", "-m", "dependency contract change"]);
      await mkdir(join(remote, "hooks"), { recursive: true });
      await writeFile(join(remote, "hooks/pre-receive"), "#!/usr/bin/env bash\nexit 1\n");
      await chmod(join(remote, "hooks/pre-receive"), 0o755);
      const rejected = spawnSync("bash", [join(checkout, "scripts/safe-deploy.sh"), "--self-main"], {
        cwd: checkout,
        encoding: "utf-8",
        env: { ...process.env, ...deployEnv },
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Activation failed; restoring the previous release/);
      assert.equal(
        await readFile(join(checkout, "node_modules/old-dependency-sentinel"), "utf-8"),
        "old dependencies\n",
      );
      assert.match(await readFile(join(checkout, "dist/index.js"), "utf-8"), /verified-release/);
      assert.equal(JSON.parse(await readFile(join(dataDir, "data/deploy/pending.json"), "utf-8")).new_rev, sha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("deploy rollback never hard-resets the source checkout", async () => {
  assert.doesNotMatch(await readFile(script, "utf-8"), /reset\s+--hard/);
});

test("self deploy rejects a target ref argument", () => {
  const result = spawnSync("bash", [script, "--self-main", "origin/other"], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not accept a target ref/);
});
