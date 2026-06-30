import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { paths } from "../paths.js";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface CostTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageTotals {
  requests: number;
  tokens: TokenTotals;
  cost: CostTotals;
}

export interface SourceRoot {
  source: "chat" | "scheduled" | "background" | "pi";
  root: string;
}

export interface SessionSummary {
  id: string;
  source: SourceRoot["source"];
  path: string;
  relativePath: string;
  bytes: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  compactions: number;
  models: string[];
  providers: string[];
  apis: string[];
  stopReasons: Record<string, number>;
  usage: UsageTotals;
  retryFallbackEvents: RetryFallbackEvent[];
  firstUserText?: string;
  classification: ClassificationScaffold;
  displayName?: string;
  cwd?: string;
  parentSession?: string;
  branchSummaries: number;
  promptChars: number;
  assistantChars: number;
  maxInterEventGapMs?: number;
  avgInterEventGapMs?: number;
  eventTypes: Record<string, number>;
  toolUsage: ToolBreakdownRow[];
  traceNodes: TraceNode[];
  attentionScore: number;
  attentionReasons: string[];
}

export interface TraceNode {
  id: string;
  parentId?: string;
  timestamp?: number;
  depth: number;
  kind:
    | "session"
    | "message"
    | "tool_call"
    | "tool_result"
    | "compaction"
    | "branch_summary"
    | "model_change"
    | "event";
  role?: string;
  title: string;
  preview?: string;
  toolName?: string;
  isError?: boolean;
  model?: string;
  provider?: string;
  tokens?: number;
  cost?: number;
  durationFromPreviousMs?: number;
}

export interface RetryFallbackEvent {
  timestamp?: number;
  type: "model_switch" | "provider_switch" | "tool_error" | "retry_or_fallback_text" | "api_error";
  detail: string;
}

export interface ClassificationScaffold {
  status: "unclassified";
  labels: string[];
  notes?: string;
}

export interface TimeBucket {
  date: string;
  sessions: number;
  requests: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolErrors: number;
  promptChars: number;
  assistantChars: number;
  tokens: TokenTotals;
  cost: CostTotals;
}

export interface BreakdownRow {
  key: string;
  requests: number;
  sessions: number;
  tokens: TokenTotals;
  cost: CostTotals;
}

export interface ToolBreakdownRow {
  name: string;
  calls: number;
  sessions: number;
  errors: number;
}

export interface ObservabilitySummary {
  schemaVersion: 2;
  generatedAt: string;
  dataDir: string;
  roots: SourceRoot[];
  scannedFiles: number;
  parseErrors: number;
  totals: {
    sessions: number;
    messages: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    compactions: number;
    toolErrors: number;
    promptChars: number;
    assistantChars: number;
    usage: UsageTotals;
    retryFallbackEvents: number;
  };
  timeSeries: TimeBucket[];
  byModel: BreakdownRow[];
  byProvider: BreakdownRow[];
  bySource: BreakdownRow[];
  toolUsage: ToolBreakdownRow[];
  retryFallbackEvents: RetryFallbackEvent[];
  sessions: SessionSummary[];
}

interface JsonRecord {
  [key: string]: unknown;
}

export function defaultSourceRoots(): SourceRoot[] {
  return [
    { source: "chat", root: paths.sessions },
    { source: "scheduled", root: paths.scheduledJobSessions },
    { source: "background", root: paths.backgroundSessions },
    { source: "pi", root: paths.piSessions },
  ];
}

export function observabilitySummaryPath(): string {
  return join(paths.observability, "summary.json");
}

export function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function emptyCost(): CostTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function emptyUsage(): UsageTotals {
  return { requests: 0, tokens: emptyTokens(), cost: emptyCost() };
}

function addTokens(target: TokenTotals, source: Partial<TokenTotals>): void {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.total += source.total ?? 0;
}

function addCost(target: CostTotals, source: Partial<CostTotals>): void {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.total += source.total ?? 0;
}

function addUsage(target: UsageTotals, source: UsageTotals): void {
  target.requests += source.requests;
  addTokens(target.tokens, source.tokens);
  addCost(target.cost, source.cost);
}

function dateKey(timestamp: number | undefined): string {
  const date = timestamp ? new Date(timestamp) : new Date(0);
  return date.toISOString().slice(0, 10);
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as JsonRecord;
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function usageFromMessage(message: JsonRecord): UsageTotals | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const input = asNumber(usage.input) ?? 0;
  const output = asNumber(usage.output) ?? 0;
  const cacheRead = asNumber(usage.cacheRead) ?? 0;
  const cacheWrite = asNumber(usage.cacheWrite) ?? 0;
  const total = asNumber(usage.totalTokens) ?? input + output + cacheRead + cacheWrite;
  const cost = asRecord(usage.cost);
  return {
    requests: 1,
    tokens: { input, output, cacheRead, cacheWrite, total },
    cost: {
      input: asNumber(cost?.input) ?? 0,
      output: asNumber(cost?.output) ?? 0,
      cacheRead: asNumber(cost?.cacheRead) ?? 0,
      cacheWrite: asNumber(cost?.cacheWrite) ?? 0,
      total: asNumber(cost?.total) ?? 0,
    },
  };
}

function contentBlocks(message: JsonRecord): JsonRecord[] {
  if (!Array.isArray(message.content)) return [];
  const blocks: JsonRecord[] = [];
  for (const block of message.content) {
    const record = asRecord(block);
    if (record) blocks.push(record);
  }
  return blocks;
}

function messageText(message: JsonRecord): string {
  const content = message.content;
  return (
    typeof content === "string"
      ? content
      : contentBlocks(message)
          .map((block) => asString(block.text) ?? asString(block.thinking))
          .filter((part): part is string => Boolean(part))
          .join(" ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text: string | undefined, length = 180): string | undefined {
  if (!text) return undefined;
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function textPreview(message: JsonRecord): string | undefined {
  return truncateText(messageText(message));
}

function valuePreview(value: unknown, length = 260): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return truncateText(value.replace(/\s+/g, " ").trim(), length);
  try {
    return truncateText(JSON.stringify(value), length);
  } catch {
    return undefined;
  }
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listJsonlFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out.sort();
}

function sessionIdFromPath(path: string): string {
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.jsonl$/, "") ?? path
  );
}

function detectTextEvents(message: JsonRecord): RetryFallbackEvent[] {
  const timestamp = timestampMs(message.timestamp);
  const stopReason = asString(message.stopReason);
  const text = `${textPreview(message) ?? ""} ${stopReason ?? ""}`.toLowerCase();
  const out: RetryFallbackEvent[] = [];
  if (/retry|fallback|fall back|rate limit|overloaded|timeout|temporar/.test(text)) {
    out.push({ timestamp, type: "retry_or_fallback_text", detail: text.slice(0, 220) });
  }
  if (/error|exception|failed/.test(stopReason ?? "")) {
    out.push({ timestamp, type: "api_error", detail: stopReason ?? "api error" });
  }
  return out;
}

async function parseSessionFile(
  sourceRoot: SourceRoot,
  filePath: string,
): Promise<{
  session: SessionSummary;
  parseErrors: number;
  toolEvents: { name: string; isError: boolean }[];
  modelUsage: Map<string, UsageTotals>;
  providerUsage: Map<string, UsageTotals>;
}> {
  const fileStat = await stat(filePath);
  const raw = await readFile(filePath, "utf-8");
  const session: SessionSummary = {
    id: sessionIdFromPath(filePath),
    source: sourceRoot.source,
    path: filePath,
    relativePath: relative(sourceRoot.root, filePath),
    bytes: fileStat.size,
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    compactions: 0,
    models: [],
    providers: [],
    apis: [],
    stopReasons: {},
    usage: emptyUsage(),
    retryFallbackEvents: [],
    classification: { status: "unclassified", labels: [] },
    branchSummaries: 0,
    promptChars: 0,
    assistantChars: 0,
    eventTypes: {},
    toolUsage: [],
    traceNodes: [],
    attentionScore: 0,
    attentionReasons: [],
  };
  const modelSet = new Set<string>();
  const providerSet = new Set<string>();
  const apiSet = new Set<string>();
  const toolEvents: { name: string; isError: boolean }[] = [];
  const sessionToolCounts = new Map<string, { calls: number; sessions: Set<string>; errors: number }>();
  const interEventGaps: number[] = [];
  const modelUsage = new Map<string, UsageTotals>();
  const providerUsage = new Map<string, UsageTotals>();
  let parseErrors = 0;
  let previousModel: string | undefined;
  let previousProvider: string | undefined;
  let traceIndex = 0;
  let previousTraceTimestamp: number | undefined;

  function addTraceNode(input: Omit<TraceNode, "depth" | "id"> & { id?: string }): TraceNode {
    const timestamp = input.timestamp;
    const gap =
      timestamp !== undefined && previousTraceTimestamp !== undefined
        ? Math.max(0, timestamp - previousTraceTimestamp)
        : undefined;
    if (gap !== undefined) interEventGaps.push(gap);
    if (timestamp !== undefined) previousTraceTimestamp = timestamp;
    const node: TraceNode = {
      ...input,
      id: input.id || `${session.id}:${traceIndex}`,
      durationFromPreviousMs: input.durationFromPreviousMs ?? gap,
      depth: 0,
    };
    traceIndex += 1;
    session.traceNodes.push(node);
    session.eventTypes[node.kind] = (session.eventTypes[node.kind] ?? 0) + 1;
    return node;
  }

  function getSessionToolRow(name: string): { calls: number; sessions: Set<string>; errors: number } {
    let row = sessionToolCounts.get(name);
    if (!row) {
      row = { calls: 0, sessions: new Set(), errors: 0 };
      sessionToolCounts.set(name, row);
    }
    row.sessions.add(`${session.source}:${session.id}`);
    return row;
  }

  function recordToolCall(name: string): void {
    toolEvents.push({ name, isError: false });
    getSessionToolRow(name).calls += 1;
  }

  function recordToolError(name: string): void {
    toolEvents.push({ name, isError: true });
    session.toolErrors += 1;
    getSessionToolRow(name).errors += 1;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: JsonRecord | undefined;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!parsed) continue;

    if (parsed.type === "session") {
      session.displayName ??= asString(parsed.name);
      session.cwd = asString(parsed.cwd) ?? session.cwd;
      session.parentSession = asString(parsed.parentSession) ?? session.parentSession;
      const timestamp = timestampMs(parsed.timestamp);
      if (timestamp !== undefined) {
        session.startedAt = session.startedAt === undefined ? timestamp : Math.min(session.startedAt, timestamp);
        session.endedAt = session.endedAt === undefined ? timestamp : Math.max(session.endedAt, timestamp);
      }
      addTraceNode({
        id: asString(parsed.id),
        parentId: asString(parsed.parentId),
        timestamp,
        kind: "session",
        title: session.displayName ?? "Session started",
        preview: valuePreview({ cwd: session.cwd, parentSession: session.parentSession }),
      });
      continue;
    }

    if (parsed.type === "session_info") {
      session.displayName = asString(parsed.name) ?? session.displayName;
      addTraceNode({
        id: asString(parsed.id),
        parentId: asString(parsed.parentId),
        timestamp: timestampMs(parsed.timestamp),
        kind: "event",
        title: "Session info",
        preview: session.displayName,
      });
      continue;
    }

    const entryTimestamp = timestampMs(parsed.timestamp);
    if (entryTimestamp !== undefined) {
      session.startedAt =
        session.startedAt === undefined ? entryTimestamp : Math.min(session.startedAt, entryTimestamp);
      session.endedAt = session.endedAt === undefined ? entryTimestamp : Math.max(session.endedAt, entryTimestamp);
    }

    if (parsed.type === "model_change") {
      const model = asString(parsed.modelId);
      const provider = asString(parsed.provider);
      if (model) modelSet.add(model);
      if (provider) providerSet.add(provider);
      if (model && previousModel && previousModel !== model) {
        session.retryFallbackEvents.push({
          timestamp: entryTimestamp,
          type: "model_switch",
          detail: `${previousModel} → ${model}`,
        });
      }
      if (provider && previousProvider && previousProvider !== provider) {
        session.retryFallbackEvents.push({
          timestamp: entryTimestamp,
          type: "provider_switch",
          detail: `${previousProvider} → ${provider}`,
        });
      }
      addTraceNode({
        id: asString(parsed.id),
        parentId: asString(parsed.parentId),
        timestamp: entryTimestamp,
        kind: "model_change",
        title: "Model changed",
        preview: [provider, model].filter(Boolean).join(" / ") || undefined,
        model,
        provider,
      });
      previousModel = model ?? previousModel;
      previousProvider = provider ?? previousProvider;
      continue;
    }

    if (parsed.type === "compaction") {
      session.compactions += 1;
      addTraceNode({
        id: asString(parsed.id),
        parentId: asString(parsed.parentId),
        timestamp: entryTimestamp,
        kind: "compaction",
        title: "Context compaction",
        preview: valuePreview({
          summary: parsed.summary,
          tokensBefore: parsed.tokensBefore,
          firstKeptEntryId: parsed.firstKeptEntryId,
        }),
      });
      continue;
    }
    if (parsed.type === "branch_summary") {
      session.branchSummaries += 1;
      addTraceNode({
        id: asString(parsed.id),
        parentId: asString(parsed.parentId),
        timestamp: entryTimestamp,
        kind: "branch_summary",
        title: "Branch summary",
        preview: valuePreview(parsed.summary ?? parsed),
      });
      continue;
    }

    const message = parsed.type === "message" ? asRecord(parsed.message) : parsed;
    if (!message) continue;
    if (message.timestamp === undefined && entryTimestamp !== undefined) message.timestamp = entryTimestamp;
    const timestamp = timestampMs(message.timestamp) ?? entryTimestamp;

    session.messages += 1;
    const text = messageText(message);
    if (message.role === "user") {
      session.userMessages += 1;
      session.promptChars += text.length;
      session.firstUserText ??= session.displayName ?? textPreview(message);
    }
    if (message.role === "assistant") {
      session.assistantMessages += 1;
      session.assistantChars += text.length;
    }
    if (message.role === "toolResult") {
      session.toolResults += 1;
      const toolName = asString(message.toolName) ?? "unknown";
      if (message.isError === true) {
        recordToolError(toolName);
        session.retryFallbackEvents.push({ timestamp, type: "tool_error", detail: toolName });
      }
    }

    const model = asString(message.model) ?? asString(message.responseModel);
    if (model) {
      modelSet.add(model);
      if (previousModel && previousModel !== model) {
        session.retryFallbackEvents.push({ timestamp, type: "model_switch", detail: `${previousModel} → ${model}` });
      }
      previousModel = model;
    }
    const provider = asString(message.provider);
    if (provider) {
      providerSet.add(provider);
      if (previousProvider && previousProvider !== provider) {
        session.retryFallbackEvents.push({
          timestamp,
          type: "provider_switch",
          detail: `${previousProvider} → ${provider}`,
        });
      }
      previousProvider = provider;
    }
    const api = asString(message.api);
    if (api) apiSet.add(api);
    const stopReason = asString(message.stopReason);
    if (stopReason) session.stopReasons[stopReason] = (session.stopReasons[stopReason] ?? 0) + 1;
    const usage = usageFromMessage(message);
    if (usage) {
      addUsage(session.usage, usage);
      addUsageToMap(modelUsage, model ?? "unknown", usage);
      addUsageToMap(providerUsage, provider ?? "unknown", usage);
    }

    const messageRole = asString(message.role);
    const messageToolName = asString(message.toolName);
    const messageNode = addTraceNode({
      id: asString(parsed.id),
      parentId: asString(parsed.parentId),
      timestamp,
      kind: messageRole === "toolResult" ? "tool_result" : "message",
      role: messageRole,
      title:
        messageRole === "toolResult"
          ? `Tool result · ${messageToolName ?? "unknown"}`
          : `${messageRole ?? "message"}${model ? ` · ${model}` : ""}`,
      preview: textPreview(message),
      toolName: messageToolName,
      isError: message.isError === true,
      model,
      provider,
      tokens: usage?.tokens.total,
      cost: usage?.cost.total,
    });

    let blockIndex = 0;
    for (const block of contentBlocks(message)) {
      if (block.type === "toolCall") {
        session.toolCalls += 1;
        const toolName = asString(block.name) ?? "unknown";
        recordToolCall(toolName);
        addTraceNode({
          id: asString(block.id) ?? `${messageNode.id}:tool-call:${blockIndex}`,
          parentId: messageNode.id,
          timestamp,
          kind: "tool_call",
          title: `Tool call · ${toolName}`,
          preview: valuePreview(block.arguments ?? block.input),
          toolName,
        });
      }
      if (block.type === "toolResult") {
        session.toolResults += 1;
        const toolName = asString(block.toolName) ?? "tool error";
        if (block.isError === true) {
          recordToolError(toolName);
          session.retryFallbackEvents.push({
            timestamp,
            type: "tool_error",
            detail: toolName,
          });
        }
        addTraceNode({
          id: asString(block.id) ?? `${messageNode.id}:tool-result:${blockIndex}`,
          parentId: messageNode.id,
          timestamp,
          kind: "tool_result",
          title: `Tool result · ${toolName}`,
          preview: valuePreview(block.content ?? block.text),
          toolName,
          isError: block.isError === true,
        });
      }
      blockIndex += 1;
    }
    session.retryFallbackEvents.push(...detectTextEvents(message));
  }

  session.firstUserText ??= session.displayName;
  session.models = [...modelSet].sort();
  session.providers = [...providerSet].sort();
  session.apis = [...apiSet].sort();
  if (session.startedAt !== undefined && session.endedAt !== undefined) {
    session.durationMs = Math.max(0, session.endedAt - session.startedAt);
  }
  if (interEventGaps.length > 0) {
    session.maxInterEventGapMs = Math.max(...interEventGaps);
    session.avgInterEventGapMs = interEventGaps.reduce((sum, gap) => sum + gap, 0) / interEventGaps.length;
  }
  session.toolUsage = toolRows(sessionToolCounts);
  annotateTraceDepths(session.traceNodes);
  applyAttentionScore(session);
  return { session, parseErrors, toolEvents, modelUsage, providerUsage };
}

function annotateTraceDepths(nodes: TraceNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const depthFor = (node: TraceNode): number => {
    if (!node.parentId || !byId.has(node.parentId) || visiting.has(node.id)) return 0;
    if (node.depth > 0) return node.depth;
    visiting.add(node.id);
    node.depth = Math.min(12, depthFor(byId.get(node.parentId)!) + 1);
    visiting.delete(node.id);
    return node.depth;
  };
  for (const node of nodes) depthFor(node);
}

function applyAttentionScore(session: SessionSummary): void {
  const reasons: string[] = [];
  let score = 0;
  if (session.toolErrors > 0) {
    score += session.toolErrors * 4;
    reasons.push(`${session.toolErrors} tool error${session.toolErrors === 1 ? "" : "s"}`);
  }
  if (session.retryFallbackEvents.length > 0) {
    score += session.retryFallbackEvents.length * 3;
    reasons.push(
      `${session.retryFallbackEvents.length} reliability signal${session.retryFallbackEvents.length === 1 ? "" : "s"}`,
    );
  }
  if ((session.maxInterEventGapMs ?? 0) >= 30 * 60 * 1000) {
    score += 2;
    reasons.push("long idle gap");
  }
  if (session.compactions > 0) {
    score += session.compactions;
    reasons.push(`${session.compactions} compaction${session.compactions === 1 ? "" : "s"}`);
  }
  if (session.usage.cost.total >= 1) {
    score += 2;
    reasons.push("high spend");
  }
  session.attentionScore = score;
  session.attentionReasons = reasons;
}

function breakdownRows(map: Map<string, BreakdownRow>): BreakdownRow[] {
  return [...map.values()].sort(
    (a, b) => b.cost.total - a.cost.total || b.tokens.total - a.tokens.total || a.key.localeCompare(b.key),
  );
}

function toolRows(
  toolCounts: Map<string, { calls: number; sessions: Set<string>; errors: number }>,
): ToolBreakdownRow[] {
  return [...toolCounts.entries()]
    .map(([name, row]) => ({ name, calls: row.calls, sessions: row.sessions.size, errors: row.errors }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

function getBreakdown(map: Map<string, BreakdownRow>, key: string): BreakdownRow {
  let row = map.get(key);
  if (!row) {
    row = { key, requests: 0, sessions: 0, tokens: emptyTokens(), cost: emptyCost() };
    map.set(key, row);
  }
  return row;
}

function addUsageToBreakdown(row: BreakdownRow, usage: UsageTotals): void {
  row.requests += usage.requests;
  addTokens(row.tokens, usage.tokens);
  addCost(row.cost, usage.cost);
}

function addUsageToMap(map: Map<string, UsageTotals>, key: string, usage: UsageTotals): void {
  let total = map.get(key);
  if (!total) {
    total = emptyUsage();
    map.set(key, total);
  }
  addUsage(total, usage);
}

export async function collectObservabilitySummary(
  roots: SourceRoot[] = defaultSourceRoots(),
): Promise<ObservabilitySummary> {
  const sessions: SessionSummary[] = [];
  const totals = {
    sessions: 0,
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    compactions: 0,
    toolErrors: 0,
    promptChars: 0,
    assistantChars: 0,
    usage: emptyUsage(),
    retryFallbackEvents: 0,
  };
  let parseErrors = 0;
  let scannedFiles = 0;
  const byDate = new Map<string, TimeBucket>();
  const byModel = new Map<string, BreakdownRow>();
  const byProvider = new Map<string, BreakdownRow>();
  const bySource = new Map<string, BreakdownRow>();
  const toolCounts = new Map<string, { calls: number; sessions: Set<string>; errors: number }>();
  const allEvents: RetryFallbackEvent[] = [];

  for (const root of roots) {
    for (const file of await listJsonlFiles(root.root)) {
      scannedFiles += 1;
      const parsed = await parseSessionFile(root, file);
      parseErrors += parsed.parseErrors;
      const session = parsed.session;
      sessions.push(session);
      totals.sessions += 1;
      totals.messages += session.messages;
      totals.userMessages += session.userMessages;
      totals.assistantMessages += session.assistantMessages;
      totals.toolCalls += session.toolCalls;
      totals.toolResults += session.toolResults;
      totals.compactions += session.compactions;
      totals.toolErrors += session.toolErrors;
      totals.promptChars += session.promptChars;
      totals.assistantChars += session.assistantChars;
      totals.retryFallbackEvents += session.retryFallbackEvents.length;
      addUsage(totals.usage, session.usage);
      allEvents.push(...session.retryFallbackEvents);

      const bucketKey = dateKey(session.startedAt ?? session.endedAt);
      let bucket = byDate.get(bucketKey);
      if (!bucket) {
        bucket = {
          date: bucketKey,
          sessions: 0,
          requests: 0,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolErrors: 0,
          promptChars: 0,
          assistantChars: 0,
          tokens: emptyTokens(),
          cost: emptyCost(),
        };
        byDate.set(bucketKey, bucket);
      }
      bucket.sessions += 1;
      bucket.requests += session.usage.requests;
      bucket.userMessages += session.userMessages;
      bucket.assistantMessages += session.assistantMessages;
      bucket.toolCalls += session.toolCalls;
      bucket.toolErrors += session.toolErrors;
      bucket.promptChars += session.promptChars;
      bucket.assistantChars += session.assistantChars;
      addTokens(bucket.tokens, session.usage.tokens);
      addCost(bucket.cost, session.usage.cost);

      const sourceRow = getBreakdown(bySource, session.source);
      sourceRow.sessions += 1;
      sourceRow.requests += session.usage.requests;
      addTokens(sourceRow.tokens, session.usage.tokens);
      addCost(sourceRow.cost, session.usage.cost);

      for (const [key, usage] of parsed.modelUsage) {
        const row = getBreakdown(byModel, key);
        row.sessions += 1;
        addUsageToBreakdown(row, usage);
      }
      for (const [key, usage] of parsed.providerUsage) {
        const row = getBreakdown(byProvider, key);
        row.sessions += 1;
        addUsageToBreakdown(row, usage);
      }
      for (const toolEvent of parsed.toolEvents) {
        let row = toolCounts.get(toolEvent.name);
        if (!row) {
          row = { calls: 0, sessions: new Set(), errors: 0 };
          toolCounts.set(toolEvent.name, row);
        }
        if (toolEvent.isError) row.errors += 1;
        else row.calls += 1;
        row.sessions.add(`${session.source}:${session.id}`);
      }
    }
  }

  sessions.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  allEvents.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    dataDir: paths.data,
    roots,
    scannedFiles,
    parseErrors,
    totals,
    timeSeries: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: breakdownRows(byModel),
    byProvider: breakdownRows(byProvider),
    bySource: breakdownRows(bySource),
    toolUsage: toolRows(toolCounts),
    retryFallbackEvents: allEvents.slice(0, 200),
    sessions,
  };
}

export async function writeObservabilitySummary(
  summary: ObservabilitySummary,
  filePath = observabilitySummaryPath(),
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
}

export async function loadStoredObservabilitySummary(
  filePath = observabilitySummaryPath(),
): Promise<ObservabilitySummary | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as ObservabilitySummary;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
