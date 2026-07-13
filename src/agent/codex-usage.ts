import { getCodexUsageAuth, type CodexUsageAuth } from "./auth.js";

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;

type UsageFetch = typeof fetch;
type UsageAuthGetter = (forceRefresh?: boolean) => Promise<CodexUsageAuth>;

export interface CodexUsageWindow {
  usedPercent: number;
  resetAfterSeconds?: number;
}

export type CodexSubscriptionUsage =
  | { available: true; primary: CodexUsageWindow; secondary?: CodexUsageWindow }
  | { available: false; reason: "auth" | "unavailable" };

export interface CodexUsageOptions {
  fetch?: UsageFetch;
  getAuth?: UsageAuthGetter;
  now?: () => number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWindow(value: unknown, now: number): CodexUsageWindow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const window = value as Record<string, unknown>;
  const usedPercent = finiteNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;

  const resetAfterSeconds = finiteNumber(window.reset_after_seconds);
  if (resetAfterSeconds !== undefined && resetAfterSeconds >= 0) {
    return { usedPercent: Math.min(100, Math.max(0, usedPercent)), resetAfterSeconds };
  }

  // The endpoint has returned Unix seconds historically, but tolerate epoch
  // milliseconds too so a backend representation change does not break /status.
  const resetAt = finiteNumber(window.reset_at);
  if (resetAt !== undefined) {
    const resetAtMs = resetAt > 100_000_000_000 ? resetAt : resetAt * 1000;
    return {
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetAfterSeconds: Math.max(0, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  return { usedPercent: Math.min(100, Math.max(0, usedPercent)) };
}

/** Parse only the stable quota fields used by the Codex desktop/CLI UI. */
export function parseCodexSubscriptionUsage(value: unknown, now = Date.now()): CodexSubscriptionUsage {
  if (typeof value !== "object" || value === null) return { available: false, reason: "unavailable" };
  const rateLimit = (value as Record<string, unknown>).rate_limit;
  if (typeof rateLimit !== "object" || rateLimit === null) return { available: false, reason: "unavailable" };

  const limits = rateLimit as Record<string, unknown>;
  const primary = parseWindow(limits.primary_window, now);
  if (!primary) return { available: false, reason: "unavailable" };

  // Some plans expose only the primary quota window. A missing, null, or
  // unparseable secondary window must not hide otherwise valid usage.
  const secondary = parseWindow(limits.secondary_window, now);
  return secondary ? { available: true, primary, secondary } : { available: true, primary };
}

function headersFor(auth: CodexUsageAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${auth.accessToken}`,
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  return headers;
}

/**
 * Fetch quota once, refreshing and retrying exactly once if the access token
 * is rejected. Other endpoint failures are deliberately not retried: /status
 * should stay quick and should not create background traffic.
 */
export async function getCodexSubscriptionUsage(options: CodexUsageOptions = {}): Promise<CodexSubscriptionUsage> {
  const fetchUsage = options.fetch ?? fetch;
  const getAuth = options.getAuth ?? getCodexUsageAuth;
  const now = options.now ?? Date.now;

  let auth: CodexUsageAuth;
  try {
    auth = await getAuth();
  } catch {
    return { available: false, reason: "auth" };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetchUsage(WHAM_USAGE_URL, {
        headers: headersFor(auth),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { available: false, reason: "unavailable" };
    }

    if (response.status === 401 && attempt === 0) {
      try {
        auth = await getAuth(true);
        continue;
      } catch {
        return { available: false, reason: "auth" };
      }
    }
    if (!response.ok)
      return { available: false, reason: response.status === 401 || response.status === 403 ? "auth" : "unavailable" };

    try {
      return parseCodexSubscriptionUsage(await response.json(), now());
    } catch {
      return { available: false, reason: "unavailable" };
    }
  }

  return { available: false, reason: "auth" };
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formatReset(seconds: number | undefined): string {
  if (seconds === undefined) return "reset time unavailable";
  if (seconds < 60) return "resets soon";

  const minutes = Math.ceil(seconds / 60);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainingMinutes = minutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (remainingMinutes && parts.length < 2) parts.push(`${remainingMinutes}m`);
  return `resets in ${parts.join(" ") || "<1m"}`;
}

function renderWindow(label: string, window: CodexUsageWindow): string {
  const left = Math.max(0, 100 - window.usedPercent);
  return `• ${label}: ${formatPercent(window.usedPercent)} used · ${formatPercent(left)} left · ${formatReset(window.resetAfterSeconds)}`;
}

export function renderCodexSubscriptionUsage(usage: CodexSubscriptionUsage): string {
  if (!usage.available) {
    const detail = usage.reason === "auth" ? "authentication unavailable" : "temporarily unavailable";
    return `📈 Codex subscription\n• ${detail}`;
  }
  const lines = ["📈 Codex subscription", renderWindow("5-hour", usage.primary)];
  if (usage.secondary) lines.push(renderWindow("Weekly", usage.secondary));
  return lines.join("\n");
}

export async function renderCodexSubscriptionStatus(options?: CodexUsageOptions): Promise<string> {
  return renderCodexSubscriptionUsage(await getCodexSubscriptionUsage(options));
}
