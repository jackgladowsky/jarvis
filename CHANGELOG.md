# Changelog

## 0.10.0

- Replace the JSON lexical memory cache with a bounded local SQLite FTS5 index, add labeled retrieval metrics, and render named memory citations safely in Telegram.

## 0.9.1

- Bound nightly memory-review inspection and reset scheduled sessions after context-window failures.

## 0.9.0

- Add context-aware request and tool-result budgeting.
- Preserve canonical append-only session history across compaction.
- Add correlated lifecycle audit traces and bounded resumable file reads.

## 0.8.1

- fix: use Codex backend context caps for GPT-5.6 models

## 0.8.0

- Add a secure one-time browser secret submission flow for allowlisted owner keys.

## 0.7.2

- Render primary-only Codex subscription usage in /status.

## 0.7.1

- Fix HTTP MCP DNS pinning and support explicit loopback-only local MCP endpoints.

## 0.7.0

- Add configurable approval-free mode for normal privileged actions while retaining browser hard blocks.

## 0.6.6

- fix: route lifecycle notifications as agent prompts

## 0.6.5

- fix: route lifecycle notifications as agent prompts

## 0.6.4

- fix: isolate lifecycle notification test worktrees

## 0.6.3

- Surface durable background task lifecycle notifications and reviewer failures

## 0.6.2

- add durable, read-only PR CI watching with restart recovery and deduplicated main-session results

## 0.6.1

- require pull requests to `main` to strictly increase the package version before merge
- secure browser side effects with owner-issued one-time Telegram approvals and per-request DNS network isolation
- remove the standalone observability dashboard and its LLM telemetry integration

## 0.6.0

- feat: add real `/cancel` for active chat runs
- fix: abort active agent/model/tool work during shutdown to avoid SIGTERM timeout kills
- fix: terminate cancellable bash subprocess groups and suppress stale cancelled results

## 0.5.0

- feat: add `/reasoning off|low|medium|high` to enable real model reasoning/thinking
- feat: add local AI usage observability dashboard/API and trace analytics
- feat: add DuckDB-backed live LLM telemetry with metadata-only JARVIS events, durable retry queue, and AI Observatory ingest/dashboard
- feat: add adaptive SOUL.md voice memory loaded per agent run plus nightly voice review
- feat: support per-scheduled-task model overrides
- fix: retry failed chat model calls three times, then fall back to DeepSeek V4 Flash
- fix: make `/usage` easier to scan with sections, context bar, and split totals

## 0.4.0

- feat: OpenRouter app attribution headers (JARVIS shows as named app in rankings)
- fix: always notify on startup, even without deploy marker
- fix: safe-deploy always rebuilds, never silently skips on "already up to date"

## 0.3.1

- Fix OpenRouter context window hardcode: fetch real context from API and persist to disk for instant restart availability

## 0.3.0

- feat: self-improving skill loop with code-level nudge

## 0.2.1

- feat: HTTP transport support for MCP servers (OpenRouter)
- feat: env var expansion in MCP header config

## 0.2.0

- feat: add mcp_call gateway tool for MCP server integration
- fix: lint errors and pre-push hook (typecheck + lint + format check)
- style: fix prettier formatting

## 0.1.1

- Add release skill and remove release-please

## 0.1.0

- Added `/version` in Telegram.
- Boot logs now include the running JARVIS version.
- Established semver baseline for future releases.
