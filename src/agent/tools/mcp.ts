// `mcp_call` tool — gateway to Model Context Protocol (MCP) servers.
//
// Reads MCP server config from ~/.jarvis/mcp-servers.json and exposes a
// single tool that routes tool calls to the configured server over stdio.
//
// Config format (~/.jarvis/mcp-servers.json):
//   {
//     "servers": {
//       "filesystem": {
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
//       },
//       "github": {
//         "command": "npx",
//         "args": ["-y", "@modelcontextprotocol/server-github"],
//         "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
//       }
//     }
//   }
//
// Use: ask the model to call `mcp_call` with the server name, tool name,
// and arguments. The model should know which tools each server exports.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";

// ── Config ─────────────────────────────────────────────────────────────────

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpServersConfig {
  servers: Record<string, McpServerConfig>;
}

const MCP_CONFIG_PATH = join(homedir(), ".jarvis", "mcp-servers.json");

function loadMcpServers(): McpServersConfig {
  try {
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as McpServersConfig;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { servers: {} };
    }
    throw err;
  }
}

// ── Tool Schema ─────────────────────────────────────────────────────────────

const schema = Type.Object({
  server: Type.String({
    description: "Name of the configured MCP server to call (e.g. 'filesystem', 'github').",
  }),
  tool: Type.String({
    description: "Name of the tool to invoke on the MCP server.",
  }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Arguments to pass to the tool, as a JSON object.",
    }),
  ),
});

// ── Execute ─────────────────────────────────────────────────────────────────

async function execute(params: {
  server: string;
  tool: string;
  arguments?: Record<string, any>;
}): Promise<{ content: string; isError: boolean }> {
  const config = loadMcpServers();
  const serverConfig = config.servers[params.server];

  if (!serverConfig) {
    const available = Object.keys(config.servers);
    return {
      content:
        `Unknown MCP server "${params.server}". ` +
        (available.length > 0
          ? `Available servers: ${available.join(", ")}`
          : "No MCP servers configured. Add servers to ~/.jarvis/mcp-servers.json."),
      isError: true,
    };
  }

  const client = new Client({ name: "jarvis-mcp", version: "1.0.0" }, { capabilities: {} });

  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args,
    env: serverConfig.env,
  });

  try {
    await client.connect(transport);

    const result = await client.callTool({
      name: params.tool,
      arguments: params.arguments ?? {},
    });

    // Normalise MCP result content to a plain string.
    let output: string;
    if (typeof result.content === "string") {
      output = result.content;
    } else if (Array.isArray(result.content)) {
      output = result.content
        .map((item: any) => {
          if (typeof item === "string") return item;
          if (item?.type === "text") return item.text;
          if (item?.type === "resource") return JSON.stringify(item.resource);
          return JSON.stringify(item);
        })
        .join("\n");
    } else {
      output = JSON.stringify(result.content);
    }

    return { content: output.trim(), isError: !!result.isError };
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Tool Definition ─────────────────────────────────────────────────────────

export const mcpCallTool: AgentTool<typeof schema> = {
  name: "mcp_call",
  label: "MCP Server",
  description:
    "Call a tool on a configured MCP (Model Context Protocol) server. " +
    "MCP servers provide tools like filesystem access, GitHub operations, " +
    "database queries, and more. Configure them in ~/.jarvis/mcp-servers.json. " +
    "Use this when you need capabilities from connected MCP servers.",
  parameters: schema,
  execute: async (_toolCallId, params, _signal, _onUpdate) => {
    const { content, isError } = await execute(params);
    return {
      content: [{ type: "text" as const, text: content }],
      isError,
      details: {},
    };
  },
};
