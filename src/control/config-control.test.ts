import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "jarvis-config-control-"));
  await mkdir(join(root, "prompts"), { recursive: true });
  const example = await readFile(new URL("../../config.yaml.example", import.meta.url), "utf-8");
  await writeFile(join(root, "config.yaml"), `# owner comment\n${example}`);
  await writeFile(join(root, "prompts/system.md"), "test");
  process.env.JARVIS_DATA_DIR = root;
  process.env.TELEGRAM_BOT_TOKEN = "test";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.EXA_API_KEY = "test";
  return root;
}

test("config control plans, atomically applies with CAS, preserves comments, and rolls back", async () => {
  const root = await prepare();
  const control = await import(`./config-control.js?test=${Date.now()}`);
  const initial = await control.getConfigView();
  const operations = [{ op: "set" as const, path: "scheduler.timezone", value: "Europe/London" }];
  const plan = await control.planConfigChange(operations);
  assert.equal(plan.previousRevision, initial.revision);
  assert.equal(plan.config.scheduler.timezone, "Europe/London");
  assert.equal(plan.restartRequired, true);

  const applied = await control.applyConfigChange(initial.revision, operations);
  assert.equal(applied.revision, plan.revision);
  assert.match(await readFile(join(root, "config.yaml"), "utf-8"), /^# owner comment/);
  await assert.rejects(() => control.applyConfigChange(initial.revision, operations), /concurrently/);

  const rolledBack = await control.rollbackConfig(applied.revision);
  assert.equal(rolledBack.revision, initial.revision);
  assert.equal(rolledBack.config.scheduler.timezone, "UTC");
});

test("config control rejects invalid and unknown paths without changing the file", async () => {
  const root = await prepare();
  const control = await import(`./config-control.js?test=${Date.now()}b`);
  const before = await readFile(join(root, "config.yaml"), "utf-8");
  await assert.rejects(
    () => control.planConfigChange([{ op: "set", path: "scheduler.timezone", value: "Mars/Olympus" }]),
    /IANA timezone/,
  );
  await assert.rejects(
    () => control.planConfigChange([{ op: "set", path: "scheduler.timezne", value: "Europe/London" }]),
    /unrecognized key|timezne/i,
  );
  assert.equal(await readFile(join(root, "config.yaml"), "utf-8"), before);
  const plan = await control.planConfigChange([{ op: "set", path: "agent.model", value: "another-model" }]);
  assert.equal(plan.restartRequired, false);
  await assert.rejects(
    () => control.planConfigChange([{ op: "set", path: "schema_version", value: 99 }]),
    /managed by JARVIS/,
  );
  const view = await control.getConfigView();
  process.env.JARVIS_BACKGROUND_BOOTSTRAPPED = "1";
  try {
    await assert.rejects(
      () => control.applyConfigChange(view.revision, [{ op: "set", path: "agent.model", value: "blocked" }]),
      /background context/,
    );
  } finally {
    delete process.env.JARVIS_BACKGROUND_BOOTSTRAPPED;
  }
});

test("mixed model patches and model rollbacks reconcile the persisted runtime override", async () => {
  await prepare();
  const control = await import(`./config-control.js?test=${Date.now()}c`);
  const { paths } = await import("../paths.js");
  const initial = await control.getConfigView();
  const applied = await control.applyConfigChange(initial.revision, [
    { op: "set", path: "agent.model", value: "mixed-model" },
    { op: "set", path: "scheduler.timezone", value: "Europe/London" },
  ]);
  assert.equal(applied.restartRequired, true);
  assert.deepEqual(JSON.parse(await readFile(paths.runtimeModel, "utf-8")), {
    provider: "codex",
    modelId: "mixed-model",
  });

  const rolledBack = await control.rollbackConfig(applied.revision);
  assert.ok(rolledBack.changedPaths.includes("agent.model"));
  assert.deepEqual(JSON.parse(await readFile(paths.runtimeModel, "utf-8")), {
    provider: "codex",
    modelId: "gpt-5.1",
  });
});
