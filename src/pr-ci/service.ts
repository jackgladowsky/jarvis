import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { paths } from "../paths.js";
import { atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { notifyMainOrFallback } from "../lib/internal-notifications.js";
import { log } from "../lib/logger.js";

const execFileAsync = promisify(execFile);
export const PR_CI_INITIAL_DELAY_MS = 15_000;
export const PR_CI_MAX_DELAY_MS = 5 * 60_000;
const FAILURE_SUMMARY_LIMIT = 1_500;

export type PrCiStatus = "pending" | "success" | "failure" | "closed";
export interface PrCiWatchState {
  version: 1;
  pr_number: number;
  head_sha: string;
  repository: string;
  chat_id: number;
  status: PrCiStatus;
  attempt: number;
  next_poll_at: string;
  updated_at: string;
  notified?: Partial<Record<PrCiStatus | "head_changed", string>>;
}
export interface PrSnapshot {
  headSha: string;
  state: "OPEN" | "CLOSED" | "MERGED";
}
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl?: string;
}
export interface PrCiClient {
  getPr(repository: string, number: number): Promise<PrSnapshot>;
  getChecks(repository: string, sha: string): Promise<CheckRun[]>;
}

function now(): string {
  return new Date().toISOString();
}
function validSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/i.test(sha);
}
function delay(attempt: number): number {
  return Math.min(PR_CI_MAX_DELAY_MS, PR_CI_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt));
}
function statePath(): string {
  return paths.prCiWatch;
}

export function classifyChecks(checks: CheckRun[]): PrCiStatus {
  if (!checks.length || checks.some((check) => check.status !== "COMPLETED")) return "pending";
  return checks.some((check) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? ""))
    ? "failure"
    : "success";
}

export function boundedFailureSummary(checks: CheckRun[]): string {
  const failed = checks.filter(
    (check) => check.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? ""),
  );
  const text =
    failed
      .map(
        (check) =>
          `- ${check.name}: ${check.conclusion ?? "unknown"}${check.detailsUrl ? ` (${check.detailsUrl})` : ""}`,
      )
      .join("\n") || "GitHub reported a failed check.";
  return text.length > FAILURE_SUMMARY_LIMIT ? `${text.slice(0, FAILURE_SUMMARY_LIMIT - 1)}…` : text;
}

export async function readPrCiWatch(): Promise<PrCiWatchState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as PrCiWatchState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
async function write(state: PrCiWatchState): Promise<void> {
  await atomicWriteJson(statePath(), state);
}

export async function startPrCiWatch(
  input: Omit<PrCiWatchState, "version" | "status" | "attempt" | "next_poll_at" | "updated_at" | "notified">,
): Promise<PrCiWatchState> {
  if (!Number.isSafeInteger(input.pr_number) || input.pr_number <= 0)
    throw new Error("PR number must be a positive integer");
  if (!validSha(input.head_sha)) throw new Error("PR head SHA must be a 40-character SHA");
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.repository)) throw new Error("repository must be owner/name");
  if (!Number.isSafeInteger(input.chat_id) || input.chat_id === 0) throw new Error("chat ID must be an integer");
  return withFileLock(statePath(), async () => {
    const state: PrCiWatchState = {
      ...input,
      version: 1,
      status: "pending",
      attempt: 0,
      next_poll_at: now(),
      updated_at: now(),
      notified: {},
    };
    await write(state);
    return state;
  });
}

export const ghPrCiClient: PrCiClient = {
  async getPr(repository, number) {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(number), "--repo", repository, "--json", "headRefOid,state"],
      { timeout: 20_000 },
    );
    const parsed = JSON.parse(stdout) as { headRefOid: string; state: "OPEN" | "CLOSED" | "MERGED" };
    return { headSha: parsed.headRefOid, state: parsed.state };
  },
  async getChecks(repository, sha) {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        `repos/${repository}/commits/${sha}/check-runs`,
        "--paginate",
        "-H",
        "Accept: application/vnd.github+json",
      ],
      { timeout: 20_000 },
    );
    const pages = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            check_runs?: Array<{ name: string; status: string; conclusion: string | null; details_url?: string }>;
          },
      );
    return pages
      .flatMap((page) => page.check_runs ?? [])
      .map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        detailsUrl: check.details_url,
      }));
  },
};

async function emit(
  state: PrCiWatchState,
  status: "success" | "failure" | "head_changed",
  checks: CheckRun[],
): Promise<void> {
  if (state.notified?.[status]) return;
  const title =
    status === "success"
      ? `PR #${state.pr_number} CI passed`
      : status === "failure"
        ? `PR #${state.pr_number} CI failed`
        : `PR #${state.pr_number} head updated`;
  const body =
    status === "success"
      ? `PR #${state.pr_number} required checks passed for exact head SHA \`${state.head_sha}\`. This is the SHA to use for the main-thread merge/deploy flow.`
      : status === "failure"
        ? `PR #${state.pr_number} checks failed for \`${state.head_sha}\`:\n${boundedFailureSummary(checks)}`
        : `PR #${state.pr_number} now points at \`${state.head_sha}\`; CI watch was reset and reconciled.`;
  const id = `pr-ci-${state.repository}-${state.pr_number}-${state.head_sha}-${status}`;
  await notifyMainOrFallback({ id, source: "system", chat_id: state.chat_id, title, body, fallback_text: body });
  state.notified = { ...state.notified, [status]: now() };
}

/** One read-only reconciliation cycle. State is committed before notification, with deterministic queue IDs for replay safety. */
export async function pollPrCiWatch(
  client: PrCiClient = ghPrCiClient,
  at = Date.now(),
): Promise<PrCiWatchState | undefined> {
  return withFileLock(statePath(), async () => {
    const state = await readPrCiWatch();
    if (!state || Date.parse(state.next_poll_at) > at || state.status === "closed") return state;
    try {
      const pr = await client.getPr(state.repository, state.pr_number);
      if (!validSha(pr.headSha)) throw new Error("GitHub returned an invalid PR head SHA");
      if (pr.headSha !== state.head_sha) {
        state.head_sha = pr.headSha;
        state.status = pr.state === "OPEN" ? "pending" : "closed";
        state.attempt = 0;
        state.next_poll_at = new Date(at).toISOString();
        state.notified = {};
        if (pr.state === "OPEN") await emit(state, "head_changed", []);
      } else if (pr.state !== "OPEN") {
        state.status = "closed";
      } else if (state.status === "success" || state.status === "failure") {
        // Terminal results still reconcile the PR head at a bounded cadence. A
        // subsequent push must reset this durable watch instead of leaving a
        // stale green/red result attached to the old SHA.
        state.next_poll_at = new Date(at + PR_CI_MAX_DELAY_MS).toISOString();
      } else {
        const checks = await client.getChecks(state.repository, state.head_sha);
        const status = classifyChecks(checks);
        state.status = status;
        if (status === "pending") {
          state.attempt += 1;
          state.next_poll_at = new Date(at + delay(state.attempt)).toISOString();
        } else if (status === "success" || status === "failure") {
          await emit(state, status, checks);
          state.next_poll_at = new Date(at + PR_CI_MAX_DELAY_MS).toISOString();
        }
      }
      state.updated_at = now();
      await write(state);
      return state;
    } catch (err) {
      state.attempt += 1;
      state.next_poll_at = new Date(at + delay(state.attempt)).toISOString();
      state.updated_at = now();
      await write(state);
      log.warn("PR CI watch poll failed", { pr: state.pr_number, err: err instanceof Error ? err.message : err });
      return state;
    }
  });
}

export async function startPrCiWatcher(): Promise<() => void> {
  let stopped = false;
  let active = false;
  const run = async () => {
    if (stopped || active) return;
    active = true;
    try {
      await pollPrCiWatch();
    } catch (err) {
      log.warn("PR CI watch reconciliation failed", { err: err instanceof Error ? err.message : err });
    } finally {
      active = false;
    }
  };
  await run();
  const timer = setInterval(() => void run(), PR_CI_INITIAL_DELAY_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
