import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const execFile = promisify(execFileCallback);

async function prepare() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-model-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.JARVIS_SOURCE_ROOT = process.cwd();
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";

  const config = await readFile("config.yaml.example", "utf-8");
  await writeFile(join(dataDir, "config.yaml"), config, "utf-8");
  const agent = await import("./model.js");
  return {
    agent,
    dataDir,
    configPath: join(dataDir, "config.yaml"),
    runtimePath: join(dataDir, "runtime-model.json"),
  };
}

const loaded = prepare();

test.after(async () => {
  const { dataDir } = await loaded;
  await rm(dataDir, { recursive: true, force: true });
});

test("persistent model switch atomically updates config and runtime state", async () => {
  const { agent, configPath, runtimePath } = await loaded;

  agent.switchModel("codex", "gpt-5.6-terra");

  const config = parseYaml(await readFile(configPath, "utf-8")) as { agent: { provider: string; model: string } };
  assert.deepEqual(config.agent, { provider: "codex", model: "gpt-5.6-terra" });
  assert.deepEqual(JSON.parse(await readFile(runtimePath, "utf-8")), {
    provider: "codex",
    modelId: "gpt-5.6-terra",
  });
  assert.equal(agent.describeModel(), "openai-codex/gpt-5.6-terra");
});

test("temporary model switch does not alter configured or runtime persistence", async () => {
  const { agent, configPath, runtimePath } = await loaded;
  const configBefore = await readFile(configPath, "utf-8");
  const runtimeBefore = await readFile(runtimePath, "utf-8");

  agent.switchModel("codex", "gpt-5.6-luna", false);

  assert.equal(await readFile(configPath, "utf-8"), configBefore);
  assert.equal(await readFile(runtimePath, "utf-8"), runtimeBefore);
  assert.equal(agent.describeModel(), "openai-codex/gpt-5.6-luna");
});

test("startup completes an interrupted model persistence before reading the runtime override", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-model-recovery-"));
  try {
    const config = await readFile("config.yaml.example", "utf-8");
    await writeFile(join(dataDir, "config.yaml"), config, "utf-8");
    // Simulate a crash after config was replaced but before the old runtime
    // override could be replaced.
    await writeFile(join(dataDir, "runtime-model.json"), '{"provider":"codex","modelId":"gpt-5.6-luna"}\n', "utf-8");
    await writeFile(
      join(dataDir, "runtime-model-transaction.json"),
      '{"provider":"codex","modelId":"gpt-5.6-terra"}\n',
      "utf-8",
    );

    const moduleUrl = pathToFileURL(join(process.cwd(), "dist", "agent", "model.js")).href;
    const { stdout } = await execFile(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const agent = await import(${JSON.stringify(moduleUrl)}); console.log(agent.describeModel());`,
      ],
      { env: { ...process.env, JARVIS_DATA_DIR: dataDir } },
    );

    assert.match(stdout, /openai-codex\/gpt-5\.6-terra/);
    const persisted = parseYaml(await readFile(join(dataDir, "config.yaml"), "utf-8")) as {
      agent: { provider: string; model: string };
    };
    assert.deepEqual(persisted.agent, { provider: "codex", model: "gpt-5.6-terra" });
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "runtime-model.json"), "utf-8")), {
      provider: "codex",
      modelId: "gpt-5.6-terra",
    });
    await assert.rejects(readFile(join(dataDir, "runtime-model-transaction.json"), "utf-8"), { code: "ENOENT" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
