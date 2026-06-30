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

- top tabs for Dashboard, Sessions, Traces, and Classifications
- dense top filters for source, time window, search, and session sort
- JARVIS and Pi session/traces ingestion
- usage/cost/tool/message summary cards
- usage trend chart and cost-by-model chart
- recent session table with sort/search-aware rows
- highest-spend session panel
- tool usage and retry/fallback feeds
- classification scaffold: each session has `classification: { status: "unclassified", labels: [] }` for future local LLM annotation without mutating raw transcripts
