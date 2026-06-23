import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Usage } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { paths } from "../paths.js";
import { estimateContextTokens } from "./compaction.js";
import { model } from "./model.js";
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

interface UsageScope extends UsageTotals {
  label: string;
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

function renderTotals(scope: UsageScope): string {
  if (scope.requests === 0) return `${scope.label}: no local usage recorded`;
  return `${scope.label}: ${formatInt(scope.totalTokens)} tokens (${formatInt(scope.input)} in, ${formatInt(scope.output)} out, ${formatInt(scope.cacheRead)} cache read), ${formatMoney(scope.cost)} over ${formatInt(scope.requests)} calls`;
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
      "Usage for this chat",
      "Session: none active",
      "Context: no active session to estimate.",
      "",
      renderTotals({ label: "Local 7d total", ...weekUsage }),
      renderTotals({ label: "Local 30d total", ...monthUsage }),
      "Provider quota: not exposed by current Codex/Anthropic APIs; only limit errors reveal reset timing.",
      "Notes: token/cost totals are local pi-ai estimates from persisted assistant messages, not provider billing.",
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

  const contextLine =
    contextWindow > 0
      ? `Context: ~${formatInt(contextTokens)} / ${formatInt(contextWindow)} tokens (${formatPercent((contextTokens / contextWindow) * 100)}), ~${formatInt(Math.max(0, contextWindow - contextTokens))} remaining`
      : `Context: ~${formatInt(contextTokens)} tokens used; model context window unavailable`;

  const lines = [
    "Usage for this chat",
    `Session: ${active.sessionId}`,
    `Model: ${config.agent.provider}/${config.agent.model}`,
    contextLine,
  ];

  if (threshold > 0) {
    lines.push(`Compaction threshold: ~${formatInt(threshold)} tokens`);
  }

  lines.push(
    "",
    renderTotals({ label: "Current session local usage", ...sessionUsage }),
    renderTotals({ label: "Local 7d total", ...weekUsage }),
    renderTotals({ label: "Local 30d total", ...monthUsage }),
    "Provider quota: not exposed by current Codex/Anthropic APIs; only limit errors reveal reset timing.",
    "Notes: context is a local chars/4 estimate including rough system/tool overhead; cost is pi-ai's local estimate, not provider billing.",
  );

  return lines.join("\n");
}
