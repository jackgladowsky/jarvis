# Local AI usage observability dashboard

First-pass local/private dashboard for JARVIS AI usage. It reads existing JSONL transcripts from:

- `~/.jarvis/data/sessions` including `archive/`
- `~/.jarvis/data/jobs/sessions`
- `~/.jarvis/data/background/sessions`

It writes derived summaries to `~/.jarvis/data/observability/summary.json` and never deletes or mutates raw transcripts.

## Run

```bash
pnpm observability:index
pnpm observability:serve
```

Then open <http://127.0.0.1:8765>. For access from another Tailscale device, bind to this host's Tailscale IP instead of all interfaces:

```bash
JARVIS_OBSERVABILITY_HOST=<tailscale-ip> JARVIS_OBSERVABILITY_PORT=8765 pnpm observability:serve
```

## API

- `GET /api/health`
- `GET /api/summary` — serves cached summary or builds it if missing
- `GET /api/summary?refresh=1` / `POST /api/refresh` — rebuilds `summary.json`

## Current views

- usage over time
- model/provider/source token and cost breakdowns
- recent sessions
- tool usage
- retry/fallback signals from model/provider switches, tool errors, and retry/fallback-ish transcript metadata/text
- classification scaffold: each session has `classification: { status: "unclassified", labels: [] }` for future local LLM annotation without mutating raw transcripts
