"use client";

import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Activity,
  ArrowDownRight,
  Brain,
  Clock3,
  Cpu,
  Database,
  DollarSign,
  GitBranch,
  ListFilter,
  RefreshCcw,
  Search,
  Table2,
  TerminalSquare,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { CostTotals, ObservabilitySummary, SessionSummary, TokenTotals } from "../../../../src/observability/analytics";

type ScreenKey = "overview" | "sessions" | "traces" | "classifications";
type WindowKey = "7" | "30" | "all";
type SourceKey = "all" | SessionSummary["source"];
type SortKey = "recent" | "cost" | "tokens" | "tools" | "duration";

const usageChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
  requests: { label: "LLM calls", color: "var(--chart-2)" },
} satisfies ChartConfig;

const costChartConfig = {
  cost: { label: "Cost", color: "var(--chart-1)" },
} satisfies ChartConfig;

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });
const integerNumber = new Intl.NumberFormat("en");

function money(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function short(value: string | undefined, length = 86): string {
  if (!value) return "Untitled session";
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function formatDate(ms?: number): string {
  if (!ms) return "unknown";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function duration(ms?: number): string {
  if (!ms) return "—";
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function zeroTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function zeroCost(): CostTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addTokens(target: TokenTotals, source: TokenTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

function addCost(target: CostTotals, source: CostTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

function sinceFor(windowKey: WindowKey): number | undefined {
  if (windowKey === "all") return undefined;
  return Date.now() - Number(windowKey) * 24 * 60 * 60 * 1000;
}

function inWindow(timestamp: number | undefined, windowKey: WindowKey): boolean {
  const since = sinceFor(windowKey);
  if (!since) return true;
  return Boolean(timestamp && timestamp >= since);
}

function sessionMatchesQuery(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    session.id,
    session.path,
    session.relativePath,
    session.displayName,
    session.firstUserText,
    session.cwd,
    session.source,
    ...session.models,
    ...session.providers,
    ...session.apis,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function sortSessions(sessions: SessionSummary[], sortKey: SortKey): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (sortKey === "cost") return b.usage.cost.total - a.usage.cost.total;
    if (sortKey === "tokens") return b.usage.tokens.total - a.usage.tokens.total;
    if (sortKey === "tools") return b.toolCalls - a.toolCalls;
    if (sortKey === "duration") return (b.durationMs ?? 0) - (a.durationMs ?? 0);
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
}

function stopReasonText(session: SessionSummary): string {
  const entries = Object.entries(session.stopReasons).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([key, count]) => `${key}:${count}`).join(" · ") : "—";
}

interface DashboardProps {
  summary: ObservabilitySummary;
}

export function ObservabilityDashboard({ summary }: DashboardProps) {
  const [screen, setScreen] = React.useState<ScreenKey>("overview");
  const [source, setSource] = React.useState<SourceKey>("all");
  const [windowKey, setWindowKey] = React.useState<WindowKey>("30");
  const [sortKey, setSortKey] = React.useState<SortKey>("recent");
  const [query, setQuery] = React.useState("");
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [liveSummary, setLiveSummary] = React.useState(summary);

  const filteredSessions = React.useMemo(() => {
    return liveSummary.sessions.filter((session) => {
      const sourceMatches = source === "all" || session.source === source;
      const timeMatches = inWindow(session.endedAt ?? session.startedAt, windowKey);
      return sourceMatches && timeMatches && sessionMatchesQuery(session, query);
    });
  }, [liveSummary.sessions, query, source, windowKey]);

  const totals = React.useMemo(() => {
    const tokens = zeroTokens();
    const cost = zeroCost();
    let requests = 0;
    let toolCalls = 0;
    let messages = 0;
    let compactions = 0;
    let retryFallbackEvents = 0;
    for (const session of filteredSessions) {
      requests += session.usage.requests;
      toolCalls += session.toolCalls;
      messages += session.messages;
      compactions += session.compactions;
      retryFallbackEvents += session.retryFallbackEvents.length;
      addTokens(tokens, session.usage.tokens);
      addCost(cost, session.usage.cost);
    }
    return { tokens, cost, requests, toolCalls, messages, compactions, retryFallbackEvents };
  }, [filteredSessions]);

  const chartRows = React.useMemo(() => {
    return liveSummary.timeSeries
      .filter((bucket) => inWindow(Date.parse(`${bucket.date}T00:00:00.000Z`), windowKey))
      .map((bucket) => ({ date: bucket.date.slice(5), tokens: bucket.tokens.total, requests: bucket.requests, cost: bucket.cost.total }));
  }, [liveSummary.timeSeries, windowKey]);

  const modelRows = React.useMemo(() => {
    const rows = new Map<string, { model: string; cost: number; tokens: number; sessions: number }>();
    for (const session of filteredSessions) {
      const model = session.models[0] ?? "unknown";
      const row = rows.get(model) ?? { model, cost: 0, tokens: 0, sessions: 0 };
      row.cost += session.usage.cost.total;
      row.tokens += session.usage.tokens.total;
      row.sessions += 1;
      rows.set(model, row);
    }
    return Array.from(rows.values()).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 10);
  }, [filteredSessions]);

  const sortedSessions = React.useMemo(() => sortSessions(filteredSessions, sortKey), [filteredSessions, sortKey]);
  const recentSessions = sortedSessions.slice(0, 24);
  const topSessions = React.useMemo(() => sortSessions(filteredSessions, "cost").slice(0, 8), [filteredSessions]);
  const traceSessions = React.useMemo(() => {
    return sortSessions(
      filteredSessions.filter((session) => session.retryFallbackEvents.length > 0 || session.toolCalls > 0 || session.compactions > 0),
      sortKey,
    );
  }, [filteredSessions, sortKey]);
  const unclassifiedSessions = filteredSessions.filter((session) => session.classification.status === "unclassified");

  async function refresh() {
    setIsRefreshing(true);
    try {
      const response = await fetch("/api/summary?refresh=1", { cache: "no-store" });
      setLiveSummary((await response.json()) as ObservabilitySummary);
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col px-4 py-4 md:px-6 lg:px-8">
        <header className="sticky top-0 z-20 border-b border-border/80 bg-background/95 pb-3 pt-1 backdrop-blur">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-muted-foreground">JARVIS</div>
                <Badge variant="outline" className="rounded-none border-border/80 bg-muted/20 text-muted-foreground">Local / private</Badge>
                <Badge variant="outline" className="rounded-none border-border/80 bg-muted/20 text-muted-foreground">{liveSummary.scannedFiles} files</Badge>
                <Badge variant="outline" className="rounded-none border-border/80 bg-muted/20 text-muted-foreground">{liveSummary.parseErrors} parse errors</Badge>
              </div>
              <h1 className="text-2xl font-semibold tracking-[-0.04em] md:text-3xl">Observability</h1>
            </div>

            <div className="flex flex-col gap-2 xl:items-end">
              <Tabs value={screen} onValueChange={(value) => setScreen(value as ScreenKey)}>
                <TabsList className="grid h-10 w-full grid-cols-4 rounded-none border border-border/80 bg-muted/20 p-0 xl:w-[620px]">
                  <TabsTrigger value="overview" className="rounded-none text-xs">Dashboard</TabsTrigger>
                  <TabsTrigger value="sessions" className="rounded-none text-xs">Sessions</TabsTrigger>
                  <TabsTrigger value="traces" className="rounded-none text-xs">Traces</TabsTrigger>
                  <TabsTrigger value="classifications" className="rounded-none text-xs">Classifications</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" /> Generated {new Date(liveSummary.generatedAt).toLocaleString()}
              </div>
            </div>
          </div>

          <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(220px,1fr)_150px_150px_170px_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search sessions, model, provider, source, path…"
                className="h-9 rounded-none border-border/80 bg-card/70 pl-9 text-sm"
              />
            </div>
            <Select value={source} onValueChange={(value) => setSource(value as SourceKey)}>
              <SelectTrigger className="h-9 rounded-none border-border/80 bg-card/70 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-none">
                <SelectItem value="all">All sources</SelectItem>
                <SelectItem value="chat">Chat</SelectItem>
                <SelectItem value="scheduled">Scheduled</SelectItem>
                <SelectItem value="background">Background</SelectItem>
                <SelectItem value="pi">Pi traces</SelectItem>
              </SelectContent>
            </Select>
            <Select value={windowKey} onValueChange={(value) => setWindowKey(value as WindowKey)}>
              <SelectTrigger className="h-9 rounded-none border-border/80 bg-card/70 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-none">
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="all">All time</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortKey} onValueChange={(value) => setSortKey(value as SortKey)}>
              <SelectTrigger className="h-9 rounded-none border-border/80 bg-card/70 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-none">
                <SelectItem value="recent">Most recent</SelectItem>
                <SelectItem value="cost">Highest cost</SelectItem>
                <SelectItem value="tokens">Most tokens</SelectItem>
                <SelectItem value="tools">Most tool calls</SelectItem>
                <SelectItem value="duration">Longest duration</SelectItem>
              </SelectContent>
            </Select>
            <Button className="h-9 rounded-none" variant="outline" onClick={refresh} disabled={isRefreshing}>
              <RefreshCcw className={cn("size-4", isRefreshing && "animate-spin")} /> Refresh
            </Button>
          </div>
        </header>

        <section className="flex-1 py-4">
          {screen === "overview" ? (
            <OverviewScreen
              chartRows={chartRows}
              filteredSessions={filteredSessions}
              modelRows={modelRows}
              recentSessions={recentSessions}
              summary={liveSummary}
              topSessions={topSessions}
              totals={totals}
            />
          ) : null}
          {screen === "sessions" ? <SessionsScreen sessions={sortedSessions} totals={totals} /> : null}
          {screen === "traces" ? <TracesScreen sessions={traceSessions} summary={liveSummary} totals={totals} /> : null}
          {screen === "classifications" ? <ClassificationsScreen sessions={unclassifiedSessions} totals={totals} /> : null}
        </section>
      </div>
    </main>
  );
}

function OverviewScreen({
  chartRows,
  filteredSessions,
  modelRows,
  recentSessions,
  summary,
  topSessions,
  totals,
}: {
  chartRows: { date: string; tokens: number; requests: number; cost: number }[];
  filteredSessions: SessionSummary[];
  modelRows: { model: string; cost: number; tokens: number; sessions: number }[];
  recentSessions: SessionSummary[];
  summary: ObservabilitySummary;
  topSessions: SessionSummary[];
  totals: { tokens: TokenTotals; cost: CostTotals; requests: number; toolCalls: number; messages: number; compactions: number; retryFallbackEvents: number };
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <MetricCard icon={Activity} label="Sessions" value={integerNumber.format(filteredSessions.length)} sub="filtered runs" />
        <MetricCard icon={Zap} label="LLM calls" value={integerNumber.format(totals.requests)} sub={`${integerNumber.format(totals.messages)} events`} />
        <MetricCard icon={Cpu} label="Tokens" value={compactNumber.format(totals.tokens.total)} sub={`${compactNumber.format(totals.tokens.input)} in / ${compactNumber.format(totals.tokens.output)} out`} />
        <MetricCard icon={DollarSign} label="Cost" value={money(totals.cost.total)} sub="estimated" />
        <MetricCard icon={TerminalSquare} label="Tools" value={integerNumber.format(totals.toolCalls)} sub={`${totals.compactions} compactions`} />
        <MetricCard icon={GitBranch} label="Signals" value={integerNumber.format(totals.retryFallbackEvents)} sub="retry/fallback" />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(360px,0.85fr)]">
        <Panel title="Usage trend" description="Daily token volume from indexed session JSONL.">
          <ChartContainer config={usageChartConfig} className="h-[300px] w-full">
            <AreaChart data={chartRows} margin={{ left: 8, right: 8, top: 12, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={10} minTickGap={24} />
              <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => compactNumber.format(value)} />
              <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
              <Area type="monotone" dataKey="tokens" stroke="var(--color-tokens)" fill="var(--color-tokens)" fillOpacity={0.16} strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        </Panel>

        <Panel title="Cost by primary model" description="Top models in the active slice.">
          <ChartContainer config={costChartConfig} className="h-[300px] w-full">
            <BarChart data={modelRows} layout="vertical" margin={{ left: 4, right: 12, top: 8, bottom: 8 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="model" tickLine={false} axisLine={false} width={118} tickFormatter={(value: string) => short(value, 18)} />
              <ChartTooltip content={<ChartTooltipContent formatter={(value) => money(Number(value))} hideLabel />} />
              <Bar dataKey="cost" fill="var(--color-cost)" radius={0} />
            </BarChart>
          </ChartContainer>
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(350px,0.75fr)_minmax(0,1.25fr)]">
        <Panel title="Top spend" description="Most expensive sessions in the filtered slice.">
          <DenseSessionList sessions={topSessions} />
        </Panel>
        <Panel title="Recent sessions" description="Compact work log. Use the Sessions tab for the full table.">
          <SessionTable sessions={recentSessions} compact />
        </Panel>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <Panel title="Tool usage" description="Top tools across all indexed sessions.">
          <ToolUsage summary={summary} />
        </Panel>
        <Panel title="Reliability feed" description="Detected switches, errors, retries, and fallback-ish text.">
          <ReliabilityFeed summary={summary} />
        </Panel>
      </div>
    </div>
  );
}

function SessionsScreen({ sessions, totals }: { sessions: SessionSummary[]; totals: { tokens: TokenTotals; cost: CostTotals; requests: number; toolCalls: number; messages: number } }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard icon={Table2} label="Rows" value={integerNumber.format(sessions.length)} sub="matching sessions" />
        <MetricCard icon={Zap} label="Calls" value={integerNumber.format(totals.requests)} sub="assistant usage records" />
        <MetricCard icon={Cpu} label="Tokens" value={compactNumber.format(totals.tokens.total)} sub="active filter" />
        <MetricCard icon={DollarSign} label="Cost" value={money(totals.cost.total)} sub="active filter" />
      </div>
      <Panel title="Sessions" description="Sortable from the top bar. Search matches text, path, source, provider, and model.">
        <SessionTable sessions={sessions.slice(0, 250)} />
      </Panel>
    </div>
  );
}

function TracesScreen({ sessions, summary, totals }: { sessions: SessionSummary[]; summary: ObservabilitySummary; totals: { retryFallbackEvents: number; toolCalls: number; compactions: number } }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard icon={GitBranch} label="Trace rows" value={integerNumber.format(sessions.length)} sub="tools/signals/compactions" />
        <MetricCard icon={TerminalSquare} label="Tool calls" value={integerNumber.format(totals.toolCalls)} sub="active filter" />
        <MetricCard icon={ArrowDownRight} label="Events" value={integerNumber.format(totals.retryFallbackEvents)} sub="retry/fallback" />
        <MetricCard icon={Database} label="Compactions" value={integerNumber.format(totals.compactions)} sub="summaries written" />
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
        <Panel title="Trace sessions" description="Sessions with tool calls, compactions, or reliability events.">
          <TraceTable sessions={sessions.slice(0, 250)} />
        </Panel>
        <Panel title="Event feed" description="Latest reliability events from the global index.">
          <ReliabilityFeed summary={summary} limit={18} />
        </Panel>
      </div>
    </div>
  );
}

function ClassificationsScreen({ sessions, totals }: { sessions: SessionSummary[]; totals: { messages: number } }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <MetricCard icon={Brain} label="Unclassified" value={integerNumber.format(sessions.length)} sub="session scaffold" />
        <MetricCard icon={Activity} label="Messages" value={integerNumber.format(totals.messages)} sub="in active slice" />
        <MetricCard icon={ListFilter} label="Labels" value="0" sub="not annotated yet" />
        <MetricCard icon={Database} label="Mutation" value="0" sub="raw logs untouched" />
      </div>
      <div className="grid gap-3 xl:grid-cols-[360px_1fr]">
        <Panel title="Classifier backlog" description="Everything is intentionally read-only for now.">
          <div className="space-y-3 text-sm text-muted-foreground">
            <div className="border border-border/60 p-3">
              Each session currently includes <span className="font-mono text-foreground">classification: unclassified</span> as a safe scaffold.
            </div>
            <div className="border border-border/60 p-3">
              Next useful step: local LLM batch classifier that writes derived labels into the observability cache, never into raw transcripts.
            </div>
          </div>
        </Panel>
        <Panel title="Unclassified sessions" description="Candidates for future topic/outcome/sentiment labels.">
          <SessionTable sessions={sessions.slice(0, 250)} compact />
        </Panel>
      </div>
    </div>
  );
}

function SessionTable({ sessions, compact = false }: { sessions: SessionSummary[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto border border-border/70">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[132px]">Ended</TableHead>
            <TableHead>Session</TableHead>
            <TableHead>Source</TableHead>
            {!compact ? <TableHead>Provider</TableHead> : null}
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Tools</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            {!compact ? <TableHead className="text-right">Duration</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.path} className="hover:bg-muted/30">
              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatDate(session.endedAt)}</TableCell>
              <TableCell>
                <div className="max-w-[760px] truncate font-medium">{short(session.displayName ?? session.firstUserText, compact ? 105 : 140)}</div>
                <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                  {(session.models.length ? session.models : ["unknown"]).slice(0, 2).map((model) => <span key={model} className="truncate">{short(model, 46)}</span>)}
                  <span>·</span>
                  <span className="truncate">{session.relativePath}</span>
                </div>
              </TableCell>
              <TableCell><Badge variant="outline" className="rounded-none capitalize">{session.source}</Badge></TableCell>
              {!compact ? <TableCell className="text-xs text-muted-foreground">{session.providers.join(", ") || "—"}</TableCell> : null}
              <TableCell className="text-right font-mono text-xs">{compactNumber.format(session.usage.tokens.total)}</TableCell>
              <TableCell className="text-right font-mono text-xs">{integerNumber.format(session.toolCalls)}</TableCell>
              <TableCell className="text-right font-mono text-xs">{money(session.usage.cost.total)}</TableCell>
              {!compact ? <TableCell className="text-right font-mono text-xs">{duration(session.durationMs)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TraceTable({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className="overflow-x-auto border border-border/70">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[132px]">Time</TableHead>
            <TableHead>Trace</TableHead>
            <TableHead className="text-right">Tools</TableHead>
            <TableHead className="text-right">Signals</TableHead>
            <TableHead className="text-right">Compactions</TableHead>
            <TableHead>Stop reasons</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((session) => (
            <TableRow key={session.path} className="hover:bg-muted/30">
              <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatDate(session.endedAt)}</TableCell>
              <TableCell>
                <div className="max-w-[700px] truncate font-medium">{short(session.displayName ?? session.firstUserText, 130)}</div>
                <div className="mt-1 text-xs text-muted-foreground">{short(session.models.join(", ") || "unknown", 120)}</div>
              </TableCell>
              <TableCell className="text-right font-mono text-xs">{session.toolCalls}</TableCell>
              <TableCell className="text-right font-mono text-xs">{session.retryFallbackEvents.length}</TableCell>
              <TableCell className="text-right font-mono text-xs">{session.compactions}</TableCell>
              <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">{stopReasonText(session)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DenseSessionList({ sessions }: { sessions: SessionSummary[] }) {
  if (sessions.length === 0) return <div className="text-sm text-muted-foreground">No sessions in this slice.</div>;
  return (
    <div className="space-y-2">
      {sessions.map((session) => (
        <div key={session.path} className="border-l border-border pl-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{short(session.displayName ?? session.firstUserText, 62)}</span>
            <span className="font-mono text-muted-foreground">{money(session.usage.cost.total)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{formatDate(session.endedAt)}</span><span>·</span><span>{compactNumber.format(session.usage.tokens.total)} tok</span><span>·</span><span>{session.toolCalls} tools</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolUsage({ summary }: { summary: ObservabilitySummary }) {
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {summary.toolUsage.slice(0, 12).map((tool) => (
        <div key={tool.name} className="grid grid-cols-[1fr_auto] items-center gap-3 border border-border/60 px-3 py-2">
          <div className="flex items-center gap-2 truncate text-sm"><TerminalSquare className="size-4 text-muted-foreground" /><span className="truncate">{tool.name}</span></div>
          <div className="font-mono text-xs text-muted-foreground">{integerNumber.format(tool.calls)}</div>
        </div>
      ))}
    </div>
  );
}

function ReliabilityFeed({ summary, limit = 10 }: { summary: ObservabilitySummary; limit?: number }) {
  return (
    <div className="space-y-2">
      {summary.retryFallbackEvents.slice(0, limit).map((event, index) => (
        <div key={`${event.timestamp ?? "event"}-${index}`} className="border border-border/60 px-3 py-2">
          <div className="mb-1 flex items-center justify-between gap-3">
            <Badge variant="outline" className="rounded-none">{event.type.replaceAll("_", " ")}</Badge>
            <span className="font-mono text-xs text-muted-foreground">{formatDate(event.timestamp)}</span>
          </div>
          <div className="text-sm text-muted-foreground">{short(event.detail, 150)}</div>
        </div>
      ))}
      {summary.retryFallbackEvents.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><ArrowDownRight className="size-4" /> No reliability events detected.</div>
      ) : null}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub: string }) {
  return (
    <Card className="rounded-none border-border/70 bg-card/70 shadow-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-1.5">
        <CardDescription className="text-[11px] uppercase tracking-[0.18em]">{label}</CardDescription>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-[-0.04em]">{value}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}

function Panel({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="rounded-none border-border/70 bg-card/70 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm tracking-[-0.02em]">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
