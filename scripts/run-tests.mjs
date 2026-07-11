#!/usr/bin/env node
import { cp, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = await mkdtemp(join(tmpdir(), "jarvis-test-data-"));

async function testFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await testFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(path);
  }
  return out;
}

try {
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await cp(join(root, "config.yaml.example"), join(dataDir, "config.yaml"));
  await cp(join(root, "prompts", "system.md.example"), join(dataDir, "prompts", "system.md"));
  const files = await testFiles(join(root, "dist"));
  if (files.length === 0) throw new Error("compiled test suite is empty; run pnpm build first");

  const child = spawn(process.execPath, ["--test", ...files], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      JARVIS_DATA_DIR: dataDir,
      JARVIS_SOURCE_ROOT: root,
      TELEGRAM_BOT_TOKEN: "test-telegram-token",
      TELEGRAM_ALLOWED_USER_IDS: "1",
      EXA_API_KEY: "test-exa-key",
    },
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolveCode(exitCode ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
