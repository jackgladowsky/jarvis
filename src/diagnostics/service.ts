import { constants } from "node:fs";
import { access, chmod, lstat, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config-schema.js";
import { parseConfig } from "../config-schema.js";
import type { BackgroundTask } from "../background/types.js";
import { withFileLock } from "../lib/durable-file.js";

export type DiagnosticSeverity = "info" | "warning" | "error";
export type DiagnosticRepair = "permissions" | "stale-cache" | "stale-locks";

export interface DiagnosticFinding {
  id: string;
  check: string;
  severity: DiagnosticSeverity;
  summary: string;
  actionable: boolean;
  proposedAction?: string;
  repair?: DiagnosticRepair;
}

export interface DiagnosticReport {
  generatedAt: string;
  ok: boolean;
  findings: DiagnosticFinding[];
  timedOutChecks: string[];
}

export interface DiagnosticsPaths {
  data: string;
  configYaml: string;
  cache: string;
  env: string;
  scheduledJobTasks: string;
  backgroundTasks: string;
  internalNotifications: string;
  internalNotificationsHeartbeat: string;
  deployPending: string;
  configRestartPending: string;
  workbench: string;
}

export interface DiagnosticsContext {
  config: Readonly<Config>;
  env: Readonly<Record<string, string | undefined>>;
  paths: DiagnosticsPaths;
  now?: number;
}

export interface DiagnosticsOptions {
  probeTelegram?: boolean;
  timeoutMs?: number;
}

export interface DiagnosticsDependencies {
  fetch?: typeof fetch;
  chromiumPath?: () => string;
  mcpHealth?: (signal: AbortSignal) => Promise<Array<{ name: string; ok: boolean }>>;
}

interface CheckResult {
  name: string;
  findings: DiagnosticFinding[];
}

const DAY_MS = 86_400_000;
const STALE_TASK_MS = 6 * 60 * 60_000;
const STALE_CACHE_MS = 30 * DAY_MS;
const STALE_LOCK_MS = 10 * 60_000;

function finding(
  id: string,
  check: string,
  severity: DiagnosticSeverity,
  summary: string,
  proposedAction?: string,
  repair?: DiagnosticRepair,
): DiagnosticFinding {
  return { id, check, severity, summary, actionable: Boolean(proposedAction), proposedAction, repair };
}

function safeMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code ? `operation failed (${code})` : "operation failed";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8")) as unknown;
}

async function withTimeout<T>(name: string, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${name} timed out`)), timeoutMs);
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function walk(root: string, maxDepth = 6): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      output.push(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(child, depth + 1);
    }
  }
  await visit(root, 0);
  return output;
}

async function checkConfig(context: DiagnosticsContext): Promise<CheckResult> {
  try {
    parseConfig(parseYaml(await readFile(context.paths.configYaml, "utf-8")), context.paths.configYaml);
    return { name: "config", findings: [] };
  } catch (err) {
    return {
      name: "config",
      findings: [finding("config-invalid", "config", "error", safeMessage(err), "Repair config.yaml before restart.")],
    };
  }
}

async function checkCredentials(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  const provider = context.config.agent.provider;
  if (provider === "anthropic" && !context.env.ANTHROPIC_API_KEY) {
    findings.push(
      finding(
        "credential-anthropic",
        "credentials",
        "error",
        "Selected Anthropic credential is missing.",
        "Install ANTHROPIC_API_KEY out of band.",
      ),
    );
  }
  if (provider === "openrouter" && !context.env.OPENROUTER_API_KEY) {
    findings.push(
      finding(
        "credential-openrouter",
        "credentials",
        "error",
        "Selected OpenRouter credential is missing.",
        "Install OPENROUTER_API_KEY out of band.",
      ),
    );
  }
  if (provider === "codex") {
    const path = context.env.CODEX_OAUTH_CREDS_PATH ?? join(context.paths.data, ".codex-creds.json");
    try {
      const value = (await readJson(path)) as { access?: unknown; refresh?: unknown; expires?: unknown };
      if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") {
        throw new Error("malformed");
      }
    } catch {
      findings.push(
        finding(
          "credential-codex",
          "credentials",
          "error",
          "Selected Codex credential file is missing or malformed.",
          "Install or refresh Codex OAuth credentials out of band.",
        ),
      );
    }
  }
  return { name: "credentials", findings };
}

async function checkTelegram(
  context: DiagnosticsContext,
  options: DiagnosticsOptions,
  deps: DiagnosticsDependencies,
  signal: AbortSignal,
): Promise<CheckResult> {
  const token = context.env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return {
      name: "telegram",
      findings: [
        finding(
          "telegram-token",
          "telegram",
          "error",
          "Telegram bot token is missing or malformed.",
          "Install a BotFather token out of band.",
        ),
      ],
    };
  }
  if (!options.probeTelegram) return { name: "telegram", findings: [] };
  try {
    const fetcher = deps.fetch ?? fetch;
    const response = await fetcher(`https://api.telegram.org/bot${token}/getMe`, { signal });
    const body = (await response.json()) as { ok?: boolean };
    if (!response.ok || body.ok !== true) throw new Error("probe rejected");
    return { name: "telegram", findings: [] };
  } catch {
    return {
      name: "telegram",
      findings: [
        finding(
          "telegram-connectivity",
          "telegram",
          "warning",
          "Telegram getMe probe failed.",
          "Check outbound connectivity and rotate the bot token if Telegram rejects it.",
        ),
      ],
    };
  }
}

async function checkMcp(deps: DiagnosticsDependencies, signal: AbortSignal): Promise<CheckResult> {
  if (!deps.mcpHealth) return { name: "mcp", findings: [] };
  const results = await deps.mcpHealth(signal);
  return {
    name: "mcp",
    findings: results
      .filter((result) => !result.ok)
      .map((result) =>
        finding(
          `mcp-${result.name}`,
          "mcp",
          "warning",
          `MCP server ${result.name} failed its health check.`,
          "Inspect its command/URL and referenced environment variables.",
        ),
      ),
  };
}

async function checkScheduler(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  if (context.config.scheduler.enabled && context.config.scheduler.telegram_chat_id === 0) {
    findings.push(
      finding(
        "scheduler-chat",
        "scheduler",
        "error",
        "Scheduler is enabled without a notification chat.",
        "Set scheduler.telegram_chat_id using config control.",
      ),
    );
  }
  try {
    const dynamic = (await readJson(context.paths.scheduledJobTasks)) as { tasks?: unknown[] };
    if (!Array.isArray(dynamic.tasks)) throw new Error("invalid tasks");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      findings.push(
        finding(
          "scheduler-state",
          "scheduler",
          "error",
          "Dynamic scheduler state is unreadable.",
          "Inspect tasks.json; do not delete it automatically.",
        ),
      );
  }
  return { name: "scheduler", findings };
}

async function checkStt(context: DiagnosticsContext): Promise<CheckResult> {
  if (context.config.stt.provider === "disabled") return { name: "stt", findings: [] };
  const cfg = context.config.stt.local_whisper_cpp;
  const candidates = [
    ["stt-whisper", cfg.whisper_binary_path, "whisper.cpp binary"],
    ["stt-model", cfg.model_path, "Whisper model"],
    ...(cfg.ffmpeg_path ? [["stt-ffmpeg", cfg.ffmpeg_path, "ffmpeg binary"]] : []),
  ];
  const findings: DiagnosticFinding[] = [];
  for (const [id, path, label] of candidates)
    if (!(await exists(path)))
      findings.push(
        finding(id, "stt", "error", `${label} is missing.`, "Install the dependency or update the configured path."),
      );
  return { name: "stt", findings };
}

async function checkChromium(deps: DiagnosticsDependencies): Promise<CheckResult> {
  try {
    const path = deps.chromiumPath?.();
    if (!path || !(await exists(path))) throw new Error("missing");
    return { name: "chromium", findings: [] };
  } catch {
    return {
      name: "chromium",
      findings: [
        finding(
          "chromium-missing",
          "chromium",
          "warning",
          "Playwright Chromium is unavailable.",
          "Propose running `pnpm exec playwright install chromium`; do not install automatically.",
        ),
      ],
    };
  }
}

async function checkDiskAndPermissions(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  try {
    const fs = await statfs(context.paths.data);
    const available = Number(fs.bavail) * Number(fs.bsize);
    if (available < 1_000_000_000)
      findings.push(
        finding(
          "disk-low",
          "storage",
          available < 250_000_000 ? "error" : "warning",
          `Data filesystem has ${Math.round(available / 1_048_576)} MiB available.`,
          "Free disk space; destructive cleanup is never automatic.",
        ),
      );
  } catch {
    findings.push(
      finding(
        "disk-unknown",
        "storage",
        "warning",
        "Available disk space could not be determined.",
        "Inspect the data filesystem manually.",
      ),
    );
  }
  const paths = [context.paths.data, ...(await walk(context.paths.data))];
  let insecure = 0;
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      const mode = info.mode & 0o777;
      if (info.isDirectory() ? (mode & 0o077) !== 0 : (mode & 0o077) !== 0) insecure++;
    } catch {
      /* diagnosed by other checks */
    }
  }
  if (insecure)
    findings.push(
      finding(
        "permissions-insecure",
        "permissions",
        "warning",
        `${insecure} host-local paths are accessible to group or other users.`,
        "Tighten data directories to 0700 and files to 0600.",
        "permissions",
      ),
    );
  return { name: "storage", findings };
}

async function checkBackups(context: DiagnosticsContext): Promise<CheckResult> {
  const backupDir = process.env.JARVIS_BACKUP_DIR ?? join(homedir(), "backups", "jarvis");
  try {
    const names = (await readdir(backupDir)).filter((name) => name.endsWith(".tar.gz"));
    const stats = await Promise.all(names.map((name) => stat(join(backupDir, name))));
    const newest = Math.max(...stats.map((item) => item.mtimeMs));
    if (!Number.isFinite(newest) || (context.now ?? Date.now()) - newest > 8 * DAY_MS) throw new Error("stale");
    return { name: "backups", findings: [] };
  } catch {
    return {
      name: "backups",
      findings: [
        finding(
          "backup-stale",
          "backups",
          "warning",
          "No successful local backup newer than eight days was found.",
          "Run the backup script or configure an off-box backup destination.",
        ),
      ],
    };
  }
}

async function checkBackground(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  let names: string[] = [];
  try {
    names = (await readdir(context.paths.backgroundTasks)).filter((name) => name.endsWith(".json"));
  } catch {
    return { name: "background", findings };
  }
  for (const name of names) {
    try {
      const task = (await readJson(join(context.paths.backgroundTasks, name))) as BackgroundTask;
      if (
        ["queued", "running", "researching", "implementing", "reviewing"].includes(task.status) &&
        (context.now ?? Date.now()) - Date.parse(task.updated_at) > STALE_TASK_MS
      ) {
        findings.push(
          finding(
            `background-stuck-${task.id}`,
            "background",
            "warning",
            `Background task ${task.id} has not advanced for over six hours.`,
            "Inspect or cancel the task; it will not be modified automatically.",
          ),
        );
      }
    } catch {
      findings.push(
        finding(
          `background-unreadable-${name.replace(/\.json$/, "")}`,
          "background",
          "warning",
          "A background task state file is unreadable.",
          "Inspect the state file manually.",
        ),
      );
    }
  }
  return { name: "background", findings };
}

async function checkNotifications(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  try {
    const heartbeat = (await readJson(context.paths.internalNotificationsHeartbeat)) as { updated_at?: string };
    const age = (context.now ?? Date.now()) - Date.parse(heartbeat.updated_at ?? "");
    if (!Number.isFinite(age) || age > 60_000)
      findings.push(
        finding(
          "notifications-heartbeat",
          "notifications",
          "warning",
          "Notification pump heartbeat is stale.",
          "Inspect the running service; restart requires owner approval.",
        ),
      );
  } catch {
    findings.push(
      finding(
        "notifications-heartbeat",
        "notifications",
        "warning",
        "Notification pump heartbeat is missing.",
        "Inspect the running service; restart requires owner approval.",
      ),
    );
  }
  try {
    const pending = (await readdir(context.paths.internalNotifications)).filter(
      (name) => name.endsWith(".json") && name !== "heartbeat.json",
    );
    if (pending.length > 50)
      findings.push(
        finding(
          "notifications-backlog",
          "notifications",
          "warning",
          `${pending.length} notifications are queued.`,
          "Inspect delivery failures before cleanup.",
        ),
      );
  } catch {
    /* absent queue is healthy before first use */
  }
  return { name: "notifications", findings };
}

async function checkMarkers(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  for (const [id, path, label] of [
    ["deploy-marker", context.paths.deployPending, "deploy completion"],
    ["restart-marker", context.paths.configRestartPending, "configuration restart"],
  ] as const) {
    try {
      const info = await stat(path);
      if ((context.now ?? Date.now()) - info.mtimeMs > DAY_MS)
        findings.push(
          finding(
            id,
            "lifecycle",
            "warning",
            `A ${label} marker is older than one day.`,
            "Inspect service lifecycle state; do not restart automatically.",
          ),
        );
    } catch {
      /* marker absent */
    }
  }
  return { name: "lifecycle", findings };
}

async function checkRegenerableState(context: DiagnosticsContext): Promise<CheckResult> {
  const findings: DiagnosticFinding[] = [];
  const cacheFiles = await walk(context.paths.cache);
  const stale = (
    await Promise.all(
      cacheFiles.map(async (path) => {
        try {
          const info = await stat(path);
          return info.isFile() && (context.now ?? Date.now()) - info.mtimeMs > STALE_CACHE_MS;
        } catch {
          return false;
        }
      }),
    )
  ).filter(Boolean).length;
  if (stale)
    findings.push(
      finding(
        "cache-stale",
        "cache",
        "info",
        `${stale} regenerable cache files are older than 30 days.`,
        "Remove only stale files under the cache root.",
        "stale-cache",
      ),
    );
  const lockCandidates = (await walk(context.paths.data)).filter((path) => path.endsWith(".lock"));
  let dead = 0;
  for (const path of lockCandidates) if (await staleDeadLock(path, context.now ?? Date.now())) dead++;
  if (dead)
    findings.push(
      finding(
        "locks-stale",
        "locks",
        "warning",
        `${dead} stale locks have dead owners.`,
        "Remove only locks whose recorded process is dead and whose age exceeds ten minutes.",
        "stale-locks",
      ),
    );
  return { name: "regenerable", findings };
}

async function staleDeadLock(path: string, now: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isDirectory() || now - info.mtimeMs < STALE_LOCK_MS) return false;
    const owner = (await readJson(join(path, "owner.json"))) as { pid?: number };
    if (!owner.pid || !Number.isSafeInteger(owner.pid)) return true;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

export async function runDiagnostics(
  context: DiagnosticsContext,
  options: DiagnosticsOptions = {},
  deps: DiagnosticsDependencies = {},
): Promise<DiagnosticReport> {
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 5_000, 30_000));
  const checks: Array<[string, (signal: AbortSignal) => Promise<CheckResult>]> = [
    ["config", () => checkConfig(context)],
    ["credentials", () => checkCredentials(context)],
    ["telegram", (signal) => checkTelegram(context, options, deps, signal)],
    ["mcp", (signal) => checkMcp(deps, signal)],
    ["scheduler", () => checkScheduler(context)],
    ["stt", () => checkStt(context)],
    ["chromium", () => checkChromium(deps)],
    ["storage", () => checkDiskAndPermissions(context)],
    ["backups", () => checkBackups(context)],
    ["background", () => checkBackground(context)],
    ["notifications", () => checkNotifications(context)],
    ["lifecycle", () => checkMarkers(context)],
    ["regenerable", () => checkRegenerableState(context)],
  ];
  const findings: DiagnosticFinding[] = [];
  const timedOutChecks: string[] = [];
  await Promise.all(
    checks.map(async ([name, check]) => {
      try {
        findings.push(...(await withTimeout(name, timeoutMs, check)).findings);
      } catch (err) {
        if (err instanceof Error && err.message.includes("timed out")) timedOutChecks.push(name);
        findings.push(
          finding(
            `${name}-failed`,
            name,
            "warning",
            `${name} diagnostic ${safeMessage(err)}.`,
            "Retry the diagnostic or inspect this subsystem manually.",
          ),
        );
      }
    }),
  );
  findings.sort(
    (a, b) =>
      ({ error: 0, warning: 1, info: 2 })[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity] ||
      a.id.localeCompare(b.id),
  );
  return {
    generatedAt: new Date(context.now ?? Date.now()).toISOString(),
    ok: !findings.some((item) => item.severity === "error"),
    findings,
    timedOutChecks: timedOutChecks.sort(),
  };
}

async function tightenPermissions(root: string): Promise<number> {
  const items = [root, ...(await walk(root))];
  let changed = 0;
  for (const path of items) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    const target = info.isDirectory() ? 0o700 : 0o600;
    if ((info.mode & 0o777) !== target) {
      await chmod(path, target);
      changed++;
    }
  }
  return changed;
}

export async function repairDiagnosticFinding(
  context: DiagnosticsContext,
  findingId: string,
): Promise<{ repaired: boolean; findingId: string; summary: string }> {
  if (findingId === "permissions-insecure") {
    const changed = await tightenPermissions(context.paths.data);
    return { repaired: true, findingId, summary: `Tightened permissions on ${changed} paths.` };
  }
  if (findingId === "cache-stale") {
    let changed = 0;
    for (const path of await walk(context.paths.cache)) {
      try {
        const info = await stat(path);
        if (info.isFile() && (context.now ?? Date.now()) - info.mtimeMs > STALE_CACHE_MS) {
          await rm(path, { force: true });
          changed++;
        }
      } catch {
        /* racing cache update */
      }
    }
    return { repaired: true, findingId, summary: `Removed ${changed} stale regenerable cache files.` };
  }
  if (findingId === "locks-stale") {
    let changed = 0;
    for (const path of (await walk(context.paths.data)).filter((candidate) => candidate.endsWith(".lock"))) {
      if (!(await staleDeadLock(path, context.now ?? Date.now()))) continue;
      const statePath = path.slice(0, -".lock".length);
      try {
        // Reuse the durable lock implementation's owner snapshot, reaper marker,
        // atomic rename, and ownership fencing. A direct rm here would have a
        // TOCTOU window in which a replacement live lock could be deleted.
        await withFileLock(statePath, async () => undefined, { timeoutMs: 250, staleMs: STALE_LOCK_MS });
        changed++;
      } catch {
        // The lock became live or changed after diagnosis; fail safe and leave it.
      }
    }
    return { repaired: true, findingId, summary: `Reclaimed ${changed} stale dead-owner locks safely.` };
  }
  throw new Error("This finding is not safely repairable. Return its proposed action to the owner instead.");
}
