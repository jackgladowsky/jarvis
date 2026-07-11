import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseDocument } from "yaml";
import { parseConfig, type Config } from "../config-schema.js";
import { atomicWriteFile, atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { paths } from "../paths.js";

export interface ConfigPatchOperation {
  op: "set" | "delete";
  path: string;
  value?: unknown;
}

export interface ConfigView {
  revision: string;
  config: Config;
}

export interface ConfigChangePlan extends ConfigView {
  previousRevision: string;
  changedPaths: string[];
  restartRequired: boolean;
}

const MAX_HISTORY = 10;
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BACKGROUND_ENV = ["JARVIS_BACKGROUND_BOOTSTRAPPED", "JARVIS_BACKGROUND_WORKTREE", "JARVIS_WORKTREE"];

function assertMutationAllowed(): void {
  const active = BACKGROUND_ENV.find((name) => process.env[name]);
  if (active) throw new Error(`Config mutation refused in background context (${active})`);
}

export function configRevision(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function patchPath(input: string): string[] {
  const parts = input.split(".");
  if (!parts.length || parts.some((part) => !PATH_SEGMENT.test(part))) {
    throw new Error(`Invalid config path: ${input}`);
  }
  return parts;
}

async function readCurrent(): Promise<{ raw: string; revision: string; config: Config }> {
  const raw = await readFile(paths.configYaml, "utf-8");
  return { raw, revision: configRevision(raw), config: parseConfig(parseDocument(raw).toJS(), paths.configYaml) };
}

function candidate(raw: string, operations: ConfigPatchOperation[]): ConfigChangePlan & { raw: string } {
  if (!operations.length) throw new Error("At least one config operation is required");
  const document = parseDocument(raw);
  if (document.errors.length) throw new Error(`Invalid YAML: ${document.errors[0]?.message}`);
  const changedPaths = new Set<string>();
  for (const operation of operations) {
    const path = patchPath(operation.path);
    if (operation.path === "schema_version") throw new Error("schema_version is managed by JARVIS");
    if (operation.op === "set") {
      if (!("value" in operation)) throw new Error(`set operation requires value: ${operation.path}`);
      document.setIn(path, operation.value);
    } else {
      document.deleteIn(path);
    }
    changedPaths.add(operation.path);
  }
  const nextRaw = document.toString();
  const config = parseConfig(document.toJS(), "proposed config");
  const pathsChanged = [...changedPaths].sort();
  return {
    raw: nextRaw,
    revision: configRevision(nextRaw),
    previousRevision: configRevision(raw),
    config,
    changedPaths: pathsChanged,
    restartRequired: pathsChanged.some((path) => !path.startsWith("agent.")),
  };
}

function agentRouteChanged(current: Config, next: Config): boolean {
  return current.agent.provider !== next.agent.provider || current.agent.model !== next.agent.model;
}

async function writeConfigAndRuntimeModel(
  currentRaw: string,
  current: Config,
  nextRaw: string,
  next: Config,
): Promise<void> {
  await atomicWriteFile(paths.configYaml, nextRaw, { mode: 0o600 });
  if (!agentRouteChanged(current, next)) return;
  try {
    await atomicWriteJson(
      paths.runtimeModel,
      { provider: next.agent.provider, modelId: next.agent.model },
      { mode: 0o600 },
    );
  } catch (err) {
    // Do not report a successful model config change that the persisted runtime
    // override would silently defeat on restart.
    await atomicWriteFile(paths.configYaml, currentRaw, { mode: 0o600 });
    throw err;
  }
}

async function saveHistory(raw: string, revision: string): Promise<void> {
  await mkdir(paths.configHistory, { recursive: true, mode: 0o700 });
  const name = `${Date.now()}-${revision}.yaml`;
  await writeFile(join(paths.configHistory, name), raw, { mode: 0o600, flag: "wx" });
  const entries = (await readdir(paths.configHistory))
    .filter((entry) => entry.endsWith(".yaml"))
    .sort()
    .reverse();
  await Promise.all(entries.slice(MAX_HISTORY).map((entry) => rm(join(paths.configHistory, entry), { force: true })));
}

export async function getConfigView(): Promise<ConfigView> {
  const current = await readCurrent();
  return { revision: current.revision, config: current.config };
}

export async function planConfigChange(operations: ConfigPatchOperation[]): Promise<ConfigChangePlan> {
  const current = await readCurrent();
  const { raw: _raw, ...plan } = candidate(current.raw, operations);
  return plan;
}

export async function applyConfigChange(
  expectedRevision: string,
  operations: ConfigPatchOperation[],
): Promise<ConfigChangePlan> {
  assertMutationAllowed();
  return withFileLock(paths.configYaml, async () => {
    const current = await readCurrent();
    if (current.revision !== expectedRevision) {
      throw new Error(`Config changed concurrently; expected ${expectedRevision}, current ${current.revision}`);
    }
    const { raw, ...plan } = candidate(current.raw, operations);
    await saveHistory(current.raw, current.revision);
    await writeConfigAndRuntimeModel(current.raw, current.config, raw, plan.config);
    return plan;
  });
}

export async function rollbackConfig(
  expectedRevision: string,
  targetRevision?: string,
  preflight?: (config: Config) => void | Promise<void>,
): Promise<ConfigChangePlan> {
  assertMutationAllowed();
  return withFileLock(paths.configYaml, async () => {
    const current = await readCurrent();
    if (current.revision !== expectedRevision) throw new Error("Config changed concurrently; rollback refused");
    const entries = (await readdir(paths.configHistory))
      .filter((entry) => entry.endsWith(".yaml"))
      .sort()
      .reverse();
    const selected = targetRevision
      ? entries.find((entry) => basename(entry).includes(`-${targetRevision}.yaml`))
      : entries[0];
    if (!selected)
      throw new Error(targetRevision ? `Rollback revision not found: ${targetRevision}` : "No rollback history");
    const raw = await readFile(join(paths.configHistory, selected), "utf-8");
    const restored = parseConfig(parseDocument(raw).toJS(), "rollback config");
    const modelChanged = agentRouteChanged(current.config, restored);
    if (modelChanged) {
      if (!preflight) throw new Error("Rollback model route requires preflight validation");
      await preflight(restored);
    }
    await saveHistory(current.raw, current.revision);
    await writeConfigAndRuntimeModel(current.raw, current.config, raw, restored);
    return {
      previousRevision: current.revision,
      revision: configRevision(raw),
      config: restored,
      changedPaths: modelChanged ? ["*", "agent.provider", "agent.model"] : ["*"],
      restartRequired: true,
    };
  });
}
