# Conversational diagnostics

JARVIS exposes a `diagnostics` agent tool for natural-language health checks such as “check that everything is healthy” or “why is transcription broken?”. It is not slash-command-first.

The diagnostic pass is read-only and reports structured findings with stable IDs, severity, an actionable flag, and a proposed action. Checks cover configuration, selected-provider credential presence, optional Telegram `getMe`, scheduler state, local speech-to-text dependencies, Playwright Chromium, disk capacity and data permissions, backup freshness, background workers, notifications, and deployment/restart markers. MCP process/network probes are reported as skipped: testing or discovering a specific MCP server requires a separate exact, authenticated owner approval. Each executed check has a bounded timeout. Credential values and Telegram tokens are never returned.

Safe repairs require an exact finding ID from a diagnosis and are limited to:

- tightening host-local data permissions to `0700` directories and `0600` files;
- removing regenerable cache files older than 30 days;
- removing lock directories older than ten minutes only when their recorded owner process is dead.

JARVIS must only propose package installation, credential changes, service restarts, and destructive cleanup. Those operations are never performed by the diagnostics tool.
