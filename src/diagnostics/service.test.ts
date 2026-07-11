import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { parseConfig, type Config } from "../config-schema.js";
import { repairDiagnosticFinding, runDiagnostics, type DiagnosticsContext, type DiagnosticsPaths } from "./service.js";

async function exampleConfig(): Promise<Config> {
  return parseConfig(parseYaml(await readFile(new URL("../../config.yaml.example", import.meta.url), "utf-8")));
}

async function fixture(overrides: Partial<Config> = {}): Promise<{ root: string; context: DiagnosticsContext }> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-diagnostics-"));
  const data = join(root, "data-root");
  const paths: DiagnosticsPaths = {
    data,
    configYaml: join(data, "config.yaml"),
    cache: join(data, "cache"),
    env: join(data, ".env"),
    scheduledJobTasks: join(data, "data", "jobs", "tasks.json"),
    backgroundTasks: join(data, "data", "background", "tasks"),
    internalNotifications: join(data, "data", "notifications"),
    internalNotificationsHeartbeat: join(data, "data", "notifications", "heartbeat.json"),
    deployPending: join(data, "data", "deploy", "pending.json"),
    configRestartPending: join(data, "data", "control", "restart-pending.json"),
    workbench: join(data, "data", "workbench"),
  };
  const base = await exampleConfig();
  const config = { ...base, ...overrides } as Config;
  await Promise.all([
    mkdir(paths.cache, { recursive: true }),
    mkdir(join(paths.scheduledJobTasks, ".."), { recursive: true }),
    mkdir(paths.backgroundTasks, { recursive: true }),
    mkdir(paths.internalNotifications, { recursive: true }),
  ]);
  await writeFile(paths.configYaml, await readFile(new URL("../../config.yaml.example", import.meta.url), "utf-8"));
  await writeFile(
    join(data, ".codex-creds.json"),
    JSON.stringify({ access: "present", refresh: "present", expires: Date.now() + 60_000 }),
  );
  await writeFile(paths.scheduledJobTasks, JSON.stringify({ tasks: [] }));
  await writeFile(paths.internalNotificationsHeartbeat, JSON.stringify({ updated_at: new Date().toISOString() }));
  await chmod(data, 0o700);
  for (const path of [
    paths.configYaml,
    join(data, ".codex-creds.json"),
    paths.scheduledJobTasks,
    paths.internalNotificationsHeartbeat,
  ])
    await chmod(path, 0o600);
  return {
    root,
    context: {
      config,
      env: {
        TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz_ABCDE",
        TELEGRAM_ALLOWED_USER_IDS: "1",
        EXA_API_KEY: "present",
      },
      paths,
      now: Date.now(),
    },
  };
}

function ids(report: Awaited<ReturnType<typeof runDiagnostics>>): string[] {
  return report.findings.map((item) => item.id);
}

test("diagnostics report credential, subsystem, lifecycle, and queue failures without secrets", async () => {
  const { root, context } = await fixture({
    agent: { provider: "anthropic", model: "test-model" },
    scheduler: { ...(await exampleConfig()).scheduler, enabled: true, telegram_chat_id: 123 },
  });
  process.env.JARVIS_BACKUP_DIR = join(root, "missing-backups");
  await writeFile(context.paths.scheduledJobTasks, "not-json");
  await writeFile(context.paths.internalNotificationsHeartbeat, JSON.stringify({ updated_at: "2020-01-01T00:00:00Z" }));
  await mkdir(join(context.paths.deployPending, ".."), { recursive: true });
  await writeFile(context.paths.deployPending, "{}");
  const old = new Date((context.now ?? Date.now()) - 2 * 86_400_000);
  await utimes(context.paths.deployPending, old, old);
  await writeFile(
    join(context.paths.backgroundTasks, "slow.json"),
    JSON.stringify({ id: "slow", status: "running", updated_at: "2020-01-01T00:00:00Z" }),
  );

  const report = await runDiagnostics(
    context,
    { probeTelegram: true },
    {
      fetch: async () => new Response(JSON.stringify({ ok: false }), { status: 401 }),
      chromiumPath: () => join(root, "missing-chromium"),
      mcpHealth: async () => [{ name: "calendar", ok: false }],
    },
  );

  assert.equal(report.ok, false);
  assert.deepEqual(
    [
      "credential-anthropic",
      "telegram-connectivity",
      "mcp-calendar",
      "scheduler-state",
      "chromium-missing",
      "backup-stale",
      "background-stuck-slow",
      "notifications-heartbeat",
      "deploy-marker",
    ].every((id) => ids(report).includes(id)),
    true,
  );
  assert.doesNotMatch(JSON.stringify(report), /abcdefghijklmnopqrstuvwxyz/);
  delete process.env.JARVIS_BACKUP_DIR;
});

test("diagnostics identify and repair only allowlisted permissions, stale cache, and dead locks", async () => {
  const { root, context } = await fixture();
  process.env.JARVIS_BACKUP_DIR = join(root, "backups");
  await mkdir(process.env.JARVIS_BACKUP_DIR, { recursive: true });
  await writeFile(join(process.env.JARVIS_BACKUP_DIR, "fresh.tar.gz"), "backup");

  const insecure = join(context.paths.data, "public.txt");
  await writeFile(insecure, "safe");
  await chmod(insecure, 0o644);
  const staleCache = join(context.paths.cache, "old.json");
  await writeFile(staleCache, "{}");
  const oldCacheDate = new Date((context.now ?? Date.now()) - 31 * 86_400_000);
  await utimes(staleCache, oldCacheDate, oldCacheDate);
  const lock = join(context.paths.data, "state.json.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999 }));
  const oldLockDate = new Date((context.now ?? Date.now()) - 11 * 60_000);
  await utimes(lock, oldLockDate, oldLockDate);

  const report = await runDiagnostics(context, {}, { chromiumPath: () => process.execPath, mcpHealth: async () => [] });
  assert.ok(ids(report).includes("permissions-insecure"));
  assert.ok(ids(report).includes("cache-stale"));
  assert.ok(ids(report).includes("locks-stale"));

  assert.equal((await repairDiagnosticFinding(context, "permissions-insecure")).repaired, true);
  assert.equal((await stat(insecure)).mode & 0o777, 0o600);
  assert.equal((await repairDiagnosticFinding(context, "cache-stale")).repaired, true);
  await assert.rejects(stat(staleCache), { code: "ENOENT" });
  assert.equal((await repairDiagnosticFinding(context, "locks-stale")).repaired, true);
  await assert.rejects(stat(lock), { code: "ENOENT" });
  await assert.rejects(() => repairDiagnosticFinding(context, "credential-anthropic"), /not safely repairable/);
  delete process.env.JARVIS_BACKUP_DIR;
});

test("each diagnostic is bounded and timeout details contain no secret values", async () => {
  const { root, context } = await fixture();
  process.env.JARVIS_BACKUP_DIR = join(root, "missing");
  const report = await runDiagnostics(
    context,
    { timeoutMs: 250 },
    {
      chromiumPath: () => process.execPath,
      mcpHealth: async () => new Promise(() => undefined),
    },
  );
  assert.ok(report.timedOutChecks.includes("mcp"));
  assert.ok(ids(report).includes("mcp-failed"));
  delete process.env.JARVIS_BACKUP_DIR;
});
