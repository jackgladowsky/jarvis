# Local AI usage observability dashboard

Local/private Next.js + shadcn dashboard for JARVIS AI usage. It reads existing JSONL transcripts from:

- `~/.jarvis/data/sessions` including `archive/`
- `~/.jarvis/data/jobs/sessions`
- `~/.jarvis/data/background/sessions`
- `~/.pi/agent/sessions` (Pi coding-agent session/traces JSONL)

It writes derived summaries to `~/.jarvis/data/observability/summary.json` and never deletes or mutates raw transcripts.

## Run

```bash
pnpm observability:index      # optional prebuild of the derived summary cache
pnpm observability:serve      # Next.js dashboard, defaults to 127.0.0.1:8765
```

Then open <http://127.0.0.1:8765>. For access from another Tailscale device, bind to this host's Tailscale IP instead of all interfaces:

```bash
JARVIS_OBSERVABILITY_HOST=<tailscale-ip> JARVIS_OBSERVABILITY_PORT=8765 pnpm observability:serve
```

The app lives in `apps/observability/` and uses shadcn/ui primitives, Tailwind v4, Recharts, and server-side access to the existing `src/observability/analytics.ts` collector.

## API

- `GET /api/summary` — serves cached summary or builds it if missing
- `GET /api/summary?refresh=1` / `POST /api/summary` — rebuilds `summary.json`

## Current views

- top tabs for Dashboard, Sessions, Traces, Analytics, and Classifications
- dense top filters for source, time window, search, and session sort
- JARVIS and Pi session/traces ingestion
- usage/cost/tool/message summary cards
- usage trend chart and cost-by-model chart
- recent session table with sort/search-aware rows
- highest-spend session panel
- tool usage and retry/fallback feeds
- classification scaffold: each session has `classification: { status: "unclassified", labels: [] }` for future local LLM annotation without mutating raw transcripts

## New tracing and analytics features

The observability cache is now schema version 2. The dashboard rebuilds old schema caches automatically and adds these feature-complete improvements without mutating raw logs:

1. Full per-session trace nodes for session metadata, prompts, assistant calls, tool calls, tool results, model changes, compactions, and branch summaries.
2. Expand/collapse trace tree UI with parent/child indentation for Pi-style traces and synthetic ordering for plain JARVIS JSONL logs.
3. Per-node timestamps, inter-event gaps, model/provider metadata, token counts, cost, previews, and error highlighting.
4. Session and global tool-error accounting derived from tool result events.
5. Per-session tool diagnostics table with calls, errors, error rate, and session coverage.
6. Prompt-vs-assistant character-volume analytics for pasted prompt/output size visibility.
7. Daily tool-call and tool-error chart for operational reliability trends.
8. Source breakdown by sessions, tokens, cost, and tool volume.
9. Trace event-type mix panel to show whether a slice is dominated by messages, tools, compactions, or model switches.
10. Weighted attention queue ranking sessions by tool errors, fallback/retry signals, long idle gaps, compactions, and high spend.
