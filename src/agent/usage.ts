import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { paths } from "../paths.js";
import { estimateContextTokens } from "./compaction.js";
import { model, describeModel } from "./model.js";
import * as sessions from "./session-manager.js";
import { systemPrompt } from "./system-prompt.js";
import { allTools } from "./tools/index.js";

interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

function emptyTotals(): UsageTotals {
  return { ...EMPTY_TOTALS };
}

function addUsage(total: UsageTotals, usage: Usage): void {
  total.requests += 1;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens +=
    usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  total.cost += usage.cost?.total ?? 0;
}

function isAssistantWithUsage(value: unknown): value is { role: "assistant"; timestamp?: number; usage: Usage } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { role?: unknown; usage?: unknown };
  return v.role === "assistant" && typeof v.usage === "object" && v.usage !== null;
}

async function readJsonlUsage(filePath: string, since?: number): Promise<UsageTotals> {
  const totals = emptyTotals();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return totals;
    throw err;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isAssistantWithUsage(parsed)) continue;
    if (since !== undefined && typeof parsed.timestamp === "number" && parsed.timestamp < since) continue;
    addUsage(totals, parsed.usage);
  }
  return totals;
}

function addTotals(target: UsageTotals, source: UsageTotals): void {
  target.requests += source.requests;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function aggregateLocalUsage(since?: number): Promise<UsageTotals> {
  const roots = [paths.sessions, paths.scheduledJobSessions, paths.backgroundSessions];
  const totals = emptyTotals();
  for (const root of roots) {
    for (const file of await listJsonlFiles(root)) {
      addTotals(totals, await readJsonlUsage(file, since));
    }
  }
  return totals;
}

function makeSummaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `<context-summary>\n${summary}\n</context-summary>\n\nThe text above summarizes earlier conversation that has been compacted. Continue from this point.`,
      },
    ],
    timestamp: 0,
  };
}

function estimateStaticContextTokens(): number {
  const systemTokens = Math.ceil(systemPrompt.length / 4);
  let toolsTokens = 0;
  try {
    toolsTokens = Math.ceil(JSON.stringify(allTools).length / 4);
  } catch {
    toolsTokens = 0;
  }
  return systemTokens + toolsTokens;
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function formatMoney(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatPercent(n: number): string {
  if (n < 0.1 && n > 0) return `${n.toFixed(2)}%`;
  return `${n.toFixed(1)}%`;
}

function renderUsageTotals(title: string, totals: UsageTotals): string[] {
  if (totals.requests === 0) return [`• ${title}: no local usage recorded`];
  return [
    `• ${title}: ${formatInt(totals.totalTokens)} tokens · ${formatMoney(totals.cost)} · ${formatInt(totals.requests)} calls`,
    `  ↳ in ${formatInt(totals.input)} · out ${formatInt(totals.output)} · cache ${formatInt(totals.cacheRead)}`,
  ];
}

function contextBar(used: number, total: number): string {
  if (total <= 0) return "";
  const width = 12;
  const ratio = Math.max(0, Math.min(1, used / total));
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export async function renderUsageReport(chatId: number): Promise<string> {
  const active = sessions.getActiveSession(chatId);
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const [weekUsage, monthUsage] = await Promise.all([
    aggregateLocalUsage(sevenDaysAgo),
    aggregateLocalUsage(thirtyDaysAgo),
  ]);

  if (!active) {
    return [
      "📊 Usage",
      "",
      "No active session for this chat.",
      "",
      "Recent totals",
      ...renderUsageTotals("7d", weekUsage),
      ...renderUsageTotals("30d", monthUsage),
      "",
      "_Local pi-ai estimates; provider quota is not exposed._",
    ].join("\n");
  }

  const loaded = await sessions.load(active.sessionId);
  const effectiveMessages = loaded.previousSummary
    ? [makeSummaryMessage(loaded.previousSummary), ...loaded.tail]
    : loaded.tail.slice();
  const messageTokens = estimateContextTokens(effectiveMessages);
  const staticTokens = estimateStaticContextTokens();
  const contextTokens = messageTokens + staticTokens;
  const contextWindow = model.contextWindow;
  const threshold = contextWindow > 0 ? Math.max(0, contextWindow - config.compaction.reserve_tokens) : 0;
  const sessionUsage = await readJsonlUsage(join(paths.sessions, `${active.sessionId}.jsonl`));

  const remaining = contextWindow > 0 ? Math.max(0, contextWindow - contextTokens) : 0;
  const usedPct = contextWindow > 0 ? formatPercent((contextTokens / contextWindow) * 100) : "?";
  const thresholdPct = contextWindow > 0 && threshold > 0 ? formatPercent((threshold / contextWindow) * 100) : "?";

  const lines = ["📊 Usage", "", "Session", `• id: ${active.sessionId}`, `• model: ${describeModel()}`, "", "Context"];

  if (contextWindow > 0) {
    lines.push(
      `• ${contextBar(contextTokens, contextWindow)} ${usedPct} used`,
      `• used: ~${formatInt(contextTokens)} / ${formatInt(contextWindow)}`,
      `• left: ~${formatInt(remaining)}`,
      `• compacts near: ~${formatInt(threshold)} (${thresholdPct})`,
    );
  } else {
    lines.push(`• used: ~${formatInt(contextTokens)}`, "• model context window unavailable");
  }

  lines.push(
    "",
    "Token + cost estimates",
    ...renderUsageTotals("session", sessionUsage),
    ...renderUsageTotals("7d", weekUsage),
    ...renderUsageTotals("30d", monthUsage),
    "",
    "_Costs are local pi-ai estimates, not provider billing. Context is chars/4-ish including system/tools._",
  );

  return lines.join("\n");
}
