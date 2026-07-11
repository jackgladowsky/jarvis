import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import {
  listMcpTools,
  loadMcpServers,
  MCP_CONFIG_PATH,
  type McpServerConfig,
  type McpServersConfig,
  validateStdioDefinition,
} from "../agent/tools/mcp.js";

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ENV_REFERENCE = /^\$[A-Z_][A-Z0-9_]*$/;
const SECRETISH =
  /(?:sk-|ghp_|github_pat_|bearer\s+[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]+\.|(?:token|secret|password|api[_-]?key)[=:][^$\s]{4,})/i;

const boundedString = z
  .string()
  .max(4_096)
  .refine((value) => !/[\0\r\n]/.test(value), "must not contain control/newline characters");

const managerServerSchema = z
  .object({
    command: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine((value) => !/[\0\r\n]/.test(value))
      .optional(),
    args: z
      .array(
        boundedString.refine(
          (value) => !SECRETISH.test(value),
          "looks like an inline credential; reference credentials through env instead",
        ),
      )
      .max(100)
      .optional(),
    env: z
      .record(z.string().regex(ENV_NAME, "must be an uppercase environment variable name"), z.string())
      .superRefine((values, context) => {
        for (const [key, value] of Object.entries(values)) {
          if (!ENV_REFERENCE.test(value)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "must be an environment reference such as $CALENDAR_TOKEN; raw values are forbidden",
            });
          }
        }
      })
      .optional(),
    url: z
      .string()
      .url()
      .max(2_048)
      .superRefine((value, context) => {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "must use http or https" });
        }
        if (parsed.username || parsed.password) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain embedded credentials" });
        }
        for (const key of parsed.searchParams.keys()) {
          if (/(token|secret|password|key|auth)/i.test(key)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: "must not contain credential query parameters" });
          }
        }
      })
      .optional(),
    headers: z
      .record(z.string().min(1).max(128), z.string().max(2_048))
      .superRefine((values, context) => {
        for (const [key, value] of Object.entries(values)) {
          if (!/\$[A-Z_][A-Z0-9_]*/.test(value) || SECRETISH.test(value.replace(/\$[A-Z_][A-Z0-9_]*/g, "$REF"))) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: "must contain an environment reference and no inline credential",
            });
          }
        }
      })
      .optional(),
    timeout_ms: z.number().int().min(1_000).max(120_000).default(15_000),
    read_only: z.boolean().optional(),
  })
  .strict()
  .superRefine((server, context) => {
    if (Boolean(server.command) === Boolean(server.url)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "must define exactly one of command or url" });
    }
    if (!server.command && (server.args || server.env)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "args and env require a stdio command" });
    }
    if (!server.url && server.headers) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "headers require an HTTP URL" });
    }
  });

export type ManagedMcpServerConfig = z.infer<typeof managerServerSchema>;
export type McpManagerAction = "list" | "add" | "update" | "remove" | "test" | "reload" | "discover_tools";

export interface McpManagerRequest {
  action: McpManagerAction;
  server?: string;
  config?: unknown;
}

export interface McpManagerResult {
  ok: boolean;
  action: McpManagerAction;
  message: string;
  servers?: Array<{
    name: string;
    transport: "stdio" | "http";
    readOnly: boolean | null;
    timeoutMs: number;
    environmentKeys: string[];
    headerKeys: string[];
  }>;
  tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

function assertServerName(name: string | undefined): string {
  if (!name || !SERVER_NAME.test(name)) {
    throw new Error("MCP server name must match ^[a-z][a-z0-9_-]{0,63}$");
  }
  return name;
}

function parseManagedConfig(value: unknown): ManagedMcpServerConfig {
  const parsed = managerServerSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Invalid MCP server configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "server"}: ${issue.message}`).join("; ")}`,
    );
  validateStdioDefinition(parsed.data);
  return parsed.data;
}

function publicServer(name: string, server: McpServerConfig) {
  return {
    name,
    transport: (server.url ? "http" : "stdio") as "http" | "stdio",
    readOnly: server.read_only ?? null,
    timeoutMs: server.timeout_ms ?? 15_000,
    environmentKeys: Object.keys(server.env ?? {}).sort(),
    headerKeys: Object.keys(server.headers ?? {}).sort(),
  };
}

async function readConfig(path: string): Promise<McpServersConfig> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    // Reuse the mcp_call loader for its compatibility and complete strict validation.
    void parsed;
    return loadMcpServers(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    throw err;
  }
}

async function mutateConfig(
  path: string,
  mutate: (current: McpServersConfig) => McpServersConfig,
): Promise<McpServersConfig> {
  return withFileLock(path, async () => {
    const next = mutate(await readConfig(path));
    await atomicWriteJson(path, next, { mode: 0o600 });
    return next;
  });
}

function compactTools(tools: Awaited<ReturnType<typeof listMcpTools>>): McpManagerResult["tools"] {
  return tools.slice(0, 100).map((tool) => ({
    name: tool.name.slice(0, 300),
    description: tool.description?.slice(0, 2_000),
    inputSchema: tool.inputSchema,
  }));
}

export async function manageMcp(
  request: McpManagerRequest,
  signal?: AbortSignal,
  configPath = MCP_CONFIG_PATH,
): Promise<McpManagerResult> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("MCP management aborted");

  if (request.action === "list" || request.action === "reload") {
    const config = await readConfig(configPath);
    const servers = Object.entries(config.servers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, server]) => publicServer(name, server));
    return {
      ok: true,
      action: request.action,
      message:
        request.action === "reload"
          ? `Validated and reloaded ${servers.length} MCP server definitions.`
          : `${servers.length} MCP server definitions configured.`,
      servers,
    };
  }

  const name = assertServerName(request.server);
  if (request.action === "add") {
    const server = parseManagedConfig(request.config);
    await mutateConfig(configPath, (current) => {
      if (current.servers[name]) throw new Error(`MCP server "${name}" already exists; use update instead`);
      return { servers: { ...current.servers, [name]: server } };
    });
    return {
      ok: true,
      action: request.action,
      message: `Added ${name} as a ${server.url ? "HTTP" : "stdio"} MCP server (${server.read_only === true ? "read-only declared" : server.read_only === false ? "write-capable declared" : "automation authority unspecified"}).`,
    };
  }

  if (request.action === "update") {
    const server = parseManagedConfig(request.config);
    await mutateConfig(configPath, (current) => {
      if (!current.servers[name]) throw new Error(`Unknown MCP server "${name}"`);
      return { servers: { ...current.servers, [name]: server } };
    });
    return {
      ok: true,
      action: request.action,
      message: `Updated ${name}; the next MCP call will use the new definition.`,
    };
  }

  if (request.action === "remove") {
    await mutateConfig(configPath, (current) => {
      if (!current.servers[name]) throw new Error(`Unknown MCP server "${name}"`);
      const servers = { ...current.servers };
      delete servers[name];
      return { servers };
    });
    return { ok: true, action: request.action, message: `Removed MCP server ${name}.` };
  }

  const config = await readConfig(configPath);
  const server = config.servers[name];
  if (!server) throw new Error(`Unknown MCP server "${name}"`);
  const tools = compactTools(await listMcpTools(server, signal));
  return {
    ok: true,
    action: request.action,
    message:
      request.action === "test"
        ? `${name} is healthy and advertised ${tools?.length ?? 0} tools.`
        : `Discovered ${tools?.length ?? 0} tools on ${name}.`,
    tools: request.action === "discover_tools" ? tools : undefined,
  };
}
