// `mcp_call` tool — a bounded gateway to configured Model Context Protocol
// servers. Each invocation gets a fresh client so cancellation can close the
// underlying HTTP connection or stdio child without affecting another call.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type } from "typebox";
import { z } from "zod";
import { paths } from "../../paths.js";

// ── Config ─────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServersConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpCallParams {
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export function summarizeMcpAuditArgs(params: McpCallParams): unknown {
  return {
    server: params.server,
    tool: params.tool,
    argument_keys: Object.keys(params.arguments ?? {}).sort(),
  };
}

export function summarizeMcpAuditError(_error: unknown, params: McpCallParams): string {
  return `MCP call ${params.server}/${params.tool} failed (response omitted)`;
}

export const MCP_CONFIG_PATH = join(paths.data, "mcp-servers.json");
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
export const MCP_OUTPUT_MAX_CHARS = 32_000;

const serverConfigSchema = z
  .object({
    command: z.string().trim().min(1, "must be a non-empty command").optional(),
    args: z.array(z.string()).max(100, "must contain at most 100 arguments").optional(),
    env: z.record(z.string()).optional(),
    url: z
      .string()
      .url("must be a valid URL")
      .refine((value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      }, "must use http:// or https://")
      .optional(),
    headers: z.record(z.string()).optional(),
  })
  .strict()
  .superRefine((server, context) => {
    if (Boolean(server.command) === Boolean(server.url)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'must define exactly one transport: "command" (stdio) or "url" (HTTP)',
      });
    }
    if (!server.command && (server.args || server.env)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [server.args ? "args" : "env"],
        message: 'is only valid for a stdio server with "command"',
      });
    }
    if (!server.url && server.headers) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headers"],
        message: 'is only valid for an HTTP server with "url"',
      });
    }
  });

const serversConfigSchema = z
  .object({
    servers: z.record(serverConfigSchema),
  })
  .strict();

function describeConfigIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
}

/** Load and validate MCP config without ever falling back to a hard-coded home directory. */
export function loadMcpServers(configPath = MCP_CONFIG_PATH): McpServersConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    throw new Error(`Unable to read MCP configuration at ${configPath}: ${errorMessage(err)}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid MCP configuration at ${configPath}: expected valid JSON with shape {"servers": {...}} (${errorMessage(err)}).`,
      { cause: err },
    );
  }

  const result = serversConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid MCP configuration at ${configPath}: ${describeConfigIssues(result.error)}.`);
  }
  return result.data;
}

function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
      const envValue = process.env[name];
      if (envValue === undefined) {
        throw new Error(`MCP config references env var "${name}" in header "${key}", but it is not set`);
      }
      return envValue;
    });
  }
  return out;
}

// ── Tool schema ─────────────────────────────────────────────────────────────

const schema = Type.Object({
  server: Type.String({
    description: "Name of the configured MCP server to call (e.g. 'filesystem', 'openrouter').",
    minLength: 1,
    maxLength: 200,
  }),
  tool: Type.String({ description: "Name of the MCP tool to invoke.", minLength: 1, maxLength: 300 }),
  arguments: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Arguments to pass to the tool, as a JSON object.",
    }),
  ),
});

// ── Bounded content normalization ──────────────────────────────────────────

const MAX_ITEM_TEXT_CHARS = 16_000;
const MAX_STRUCTURED_STRING_CHARS = 4_000;
const MAX_STRUCTURED_ITEMS = 50;
const MAX_STRUCTURED_DEPTH = 6;
const OUTPUT_TRUNCATION_MARKER = `\n[MCP output truncated at ${MCP_OUTPUT_MAX_CHARS} characters]`;

function clipString(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = `...[truncated ${value.length - max} characters]...`;
  const available = Math.max(0, max - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`;
}

function compactValue(value: unknown, key: string | undefined, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    if (key === "blob" || key === "base64") return `[omitted binary payload: ${value.length} encoded characters]`;
    return clipString(value, MAX_STRUCTURED_STRING_CHARS);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_STRUCTURED_DEPTH) return "[maximum nesting depth omitted]";
  if (seen.has(value)) return "[circular reference omitted]";
  seen.add(value);

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, MAX_STRUCTURED_ITEMS)
      .map((item) => compactValue(item, undefined, depth + 1, seen));
    if (value.length > MAX_STRUCTURED_ITEMS) compacted.push(`[${value.length - MAX_STRUCTURED_ITEMS} items omitted]`);
    return compacted;
  }

  const source = value as Record<string, unknown>;
  const entries = Object.entries(source);
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries.slice(0, MAX_STRUCTURED_ITEMS)) {
    if ((source.type === "image" || source.type === "audio") && entryKey === "data") {
      out.data = `[omitted ${String(source.type)} payload: ${typeof entryValue === "string" ? entryValue.length : "unknown"} encoded characters]`;
    } else {
      out[entryKey] = compactValue(entryValue, entryKey, depth + 1, seen);
    }
  }
  if (entries.length > MAX_STRUCTURED_ITEMS) out["[omitted]"] = `${entries.length - MAX_STRUCTURED_ITEMS} fields`;
  return out;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(compactValue(value, undefined, 0, new WeakSet<object>())) ?? String(value);
  } catch (err) {
    return `[unserializable MCP content: ${errorMessage(err)}]`;
  }
}

function renderContentItem(item: unknown): string {
  if (typeof item === "string") return clipString(item, MAX_ITEM_TEXT_CHARS);
  if (!item || typeof item !== "object") return compactJson(item);

  const record = item as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return clipString(record.text, MAX_ITEM_TEXT_CHARS);
  }
  if (record.type === "image" || record.type === "audio") {
    const kind = String(record.type);
    const mime = typeof record.mimeType === "string" ? ` (${record.mimeType})` : "";
    const length = typeof record.data === "string" ? record.data.length : "unknown";
    return `[omitted MCP ${kind}${mime}: ${length} encoded characters]`;
  }
  return compactJson(item);
}

/** Convert arbitrary MCP content into bounded, text-only model context. */
export function normalizeMcpContent(content: unknown): string {
  const items = Array.isArray(content) ? content : [content];
  let out = "";
  for (const item of items.slice(0, MAX_STRUCTURED_ITEMS)) {
    const rendered = renderContentItem(item).trim();
    if (!rendered) continue;
    const separator = out ? "\n" : "";
    const remaining = MCP_OUTPUT_MAX_CHARS - OUTPUT_TRUNCATION_MARKER.length - out.length - separator.length;
    if (remaining <= 0 || rendered.length > remaining) {
      if (remaining > 0) out += separator + rendered.slice(0, remaining);
      out += OUTPUT_TRUNCATION_MARKER;
      return out;
    }
    out += separator + rendered;
  }
  if (items.length > MAX_STRUCTURED_ITEMS) {
    const marker = `\n[${items.length - MAX_STRUCTURED_ITEMS} MCP content items omitted]`;
    out = `${out.slice(0, Math.max(0, MCP_OUTPUT_MAX_CHARS - marker.length))}${marker}`;
  }
  return out || "(MCP tool returned no content)";
}

// ── Execute ─────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function closeClient(client: Client, transport: Transport): Promise<void> {
  // The SDK's stdio close escalates stdin close -> SIGTERM -> SIGKILL. Give it
  // enough time to complete that sequence, then make one final transport close
  // attempt so failed initialization cannot leave a child or HTTP session live.
  const waitFor = async (operation: Promise<unknown>, timeoutMs: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  if (await waitFor(client.close(), 5_000)) return;
  await waitFor(transport.close(), 1_000);
}

export async function callMcpTool(
  serverConfig: McpServerConfig,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  throwIfAborted(signal);
  const client = new Client({ name: "jarvis-mcp", version: "1.0.0" }, { capabilities: {} });
  const transport: Transport = serverConfig.url
    ? new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        requestInit: serverConfig.headers ? { headers: resolveHeaders(serverConfig.headers) } : undefined,
      })
    : new StdioClientTransport({
        command: serverConfig.command!,
        args: serverConfig.args,
        env: serverConfig.env,
      });

  try {
    await client.connect(transport, {
      signal: boundedSignal(signal, MCP_CONNECT_TIMEOUT_MS),
      timeout: MCP_CONNECT_TIMEOUT_MS,
      maxTotalTimeout: MCP_CONNECT_TIMEOUT_MS,
    });
    throwIfAborted(signal);
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      signal: boundedSignal(signal, MCP_CALL_TIMEOUT_MS),
      timeout: MCP_CALL_TIMEOUT_MS,
      maxTotalTimeout: MCP_CALL_TIMEOUT_MS,
    });
    return { content: normalizeMcpContent(result.content), isError: Boolean(result.isError) };
  } finally {
    await closeClient(client, transport);
  }
}

export async function executeMcpCall(
  params: McpCallParams,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  throwIfAborted(signal);
  const config = loadMcpServers();
  const serverConfig = config.servers[params.server];
  if (!serverConfig) {
    const available = Object.keys(config.servers).sort();
    return {
      content:
        `Unknown MCP server "${params.server}". ` +
        (available.length > 0
          ? `Available servers: ${available.join(", ")}`
          : `No MCP servers configured. Add servers to ${MCP_CONFIG_PATH}.`),
      isError: true,
    };
  }
  return callMcpTool(serverConfig, params.tool, params.arguments ?? {}, signal);
}

export const mcpCallTool: AgentTool<typeof schema> = {
  name: "mcp_call",
  label: "MCP Server",
  description:
    "Call a tool on a configured MCP (Model Context Protocol) server. " +
    `Servers are configured in ${MCP_CONFIG_PATH}. Returned text is compacted and binary payloads are omitted.`,
  parameters: schema,
  execute: async (_toolCallId, params, signal) => {
    const { content, isError } = await executeMcpCall(params, signal);
    // pi-agent-core treats thrown tool failures as errors; extra result fields
    // are not part of AgentToolResult and would otherwise be silently ignored.
    if (isError) throw new Error(content);
    return {
      content: [{ type: "text" as const, text: content }],
      details: {},
    };
  },
};
