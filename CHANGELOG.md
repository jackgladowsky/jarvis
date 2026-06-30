# Changelog

## Unreleased

- feat: add local AI usage observability dashboard/API over JARVIS session JSONL
- feat: retry failed chat model calls three times, then fall back to DeepSeek V4 Flash
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
