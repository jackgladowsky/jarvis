# Conversational MCP integrations

MCP integrations are managed primarily through normal conversation. Examples:

- “Connect the local calendar MCP server in read-only mode.”
- “Test the calendar integration and show me its tools.”
- “Remove the old GitHub integration.”

JARVIS routes these requests through the typed, active-owner-chat-only `mcp_manage` control tool. Mutations, health/discovery executions, stdio calls, and write-capable HTTP calls follow `tools.owner_approval.required`: the current host default (`false`) proceeds immediately, while `true` requires an exact-plan, expiring, one-time Telegram approval. The tool validates and atomically updates `~/.jarvis/mcp-servers.json`; the existing `mcp_call` tool invokes configured tools. Prompt assembly reads the file for every turn, so successful updates require no service restart.

## Credential boundary

Never put a credential value in the JSON or in a conversational tool argument. Config fields only hold references:

```json
{
  "headers": { "Authorization": "Bearer $CALENDAR_MCP_TOKEN" },
  "env": { "CALENDAR_TOKEN": "$CALENDAR_MCP_TOKEN" }
}
```

Install the referenced environment variable through the host's protected service environment, then restart the service if its process environment changed. Manager output and audit entries include only action, server, transport, environment/header key names, and outcome metadata—not values.

## Transports and authority

A server defines exactly one transport:

- An approved MCP launcher (`node`, `npx`, `pnpm`, `bun`, `deno`, `python`, `uv`, or `uvx`) plus bounded non-eval `args` and referenced `env` for stdio. Shell/eval flags and raw credentials are rejected.
- Public `http`/`https` `url` plus referenced `headers` for HTTP. Every request and redirect is sent through DNS-pinned transport that rejects private, loopback, link-local, metadata, reserved, and rebound addresses. A local HTTP MCP endpoint must explicitly set `allow_localhost: true`; this is accepted only for `http://localhost`, `http://127.0.0.0/8`, or `http://[::1]` endpoints and does not permit any other private address or redirect target.

Manager-created definitions also specify a bounded `timeout_ms` (1–120 seconds). Set `read_only: true` explicitly to permit scheduled/background use; an omitted legacy value remains unknown and receives no automation authority. `read_only` is an authority declaration and prompt guard, not a protocol-level sandbox; only connect write-capable servers after explicitly deciding to grant that authority.

See [`mcp-servers.example.json`](../mcp-servers.example.json) for transport examples. Server packages and URLs are intentionally placeholders: review a provider's official installation instructions before connecting it.
