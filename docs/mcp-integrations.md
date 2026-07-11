# Conversational MCP integrations

MCP integrations are managed primarily through normal conversation. Examples:

- “Connect the local calendar MCP server in read-only mode.”
- “Test the calendar integration and show me its tools.”
- “Remove the old GitHub integration.”

JARVIS routes these requests through the typed `mcp_manage` control tool. The tool validates and atomically updates `~/.jarvis/mcp-servers.json`; the existing `mcp_call` tool invokes configured tools. Prompt assembly reads the file for every turn, so successful updates require no service restart.

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

- `command` plus optional `args` and referenced `env` for stdio.
- Public `http`/`https` `url` plus optional referenced `headers` for HTTP.

Manager-created definitions also specify a bounded `timeout_ms` (1–120 seconds) and default to `read_only: true`. `read_only` is an authority declaration and prompt guard, not a protocol-level sandbox; only connect write-capable servers after explicitly deciding to grant that authority.

See [`mcp-servers.example.json`](../mcp-servers.example.json) for transport examples. Server packages and URLs are intentionally placeholders: review a provider's official installation instructions before connecting it.
