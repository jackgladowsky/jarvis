import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { manageMcp } from "./mcp-manager.js";

function stdioConfig(scriptPath = "fixture-server.mjs") {
  return {
    command: process.execPath,
    args: [scriptPath],
    env: { TEST_MCP_TOKEN: "$TEST_MCP_TOKEN" },
    timeout_ms: 5_000,
    read_only: true,
  };
}

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return true;
    }
  }
  return false;
}

test("manager atomically adds, lists, updates, reloads, and removes definitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-mcp-manager-"));
  const path = join(dir, "mcp-servers.json");
  try {
    await Promise.all([
      manageMcp({ action: "add", server: "calendar", config: stdioConfig() }, undefined, path),
      manageMcp(
        {
          action: "add",
          server: "home_assistant",
          config: {
            url: "https://mcp.example.test/api",
            headers: { Authorization: "Bearer $HA_TOKEN" },
          },
        },
        undefined,
        path,
      ),
    ]);

    const listed = await manageMcp({ action: "list" }, undefined, path);
    assert.deepEqual(
      listed.servers?.map((server) => server.name),
      ["calendar", "home_assistant"],
    );
    assert.deepEqual(listed.servers?.[0]?.environmentKeys, ["TEST_MCP_TOKEN"]);
    assert.deepEqual(listed.servers?.[1]?.headerKeys, ["Authorization"]);
    assert.equal(
      listed.servers?.[1]?.readOnly,
      null,
      "legacy omitted read_only remains unknown and cannot authorize automation",
    );
    assert.doesNotMatch(JSON.stringify(listed), /Bearer|\$HA_TOKEN|\$TEST_MCP_TOKEN/);

    await manageMcp(
      { action: "update", server: "calendar", config: { ...stdioConfig(), timeout_ms: 7_000 } },
      undefined,
      path,
    );
    const reloaded = await manageMcp({ action: "reload" }, undefined, path);
    assert.match(reloaded.message, /Validated and reloaded 2/);
    assert.equal(reloaded.servers?.find((server) => server.name === "calendar")?.timeoutMs, 7_000);

    await manageMcp({ action: "remove", server: "home_assistant" }, undefined, path);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf-8")).servers), ["calendar"]);
    await assert.rejects(
      manageMcp({ action: "add", server: "calendar", config: stdioConfig() }, undefined, path),
      /already exists/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manager rejects malformed definitions and never persists or echoes raw credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-mcp-secret-"));
  const path = join(dir, "mcp-servers.json");
  const secret = "sk-super-secret-credential-value";
  try {
    await assert.rejects(
      manageMcp(
        {
          action: "add",
          server: "calendar",
          config: { command: "node", env: { CALENDAR_TOKEN: secret } },
        },
        undefined,
        path,
      ),
      (err: unknown) => {
        assert.doesNotMatch((err as Error).message, new RegExp(secret));
        assert.match((err as Error).message, /raw values are forbidden/);
        return true;
      },
    );
    await assert.rejects(
      manageMcp({ action: "add", server: "Bad Name", config: { command: "node" } }, undefined, path),
      /server name/,
    );
    await assert.rejects(
      manageMcp(
        {
          action: "add",
          server: "bad_url",
          config: { url: "https://user:pass@example.test/mcp?api_key=secret" },
        },
        undefined,
        path,
      ),
      /embedded credentials|credential query/,
    );
    await assert.rejects(readFile(path, "utf-8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("test and discovery are bounded, return tools, and close the stdio process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-mcp-discovery-"));
  const path = join(dir, "mcp-servers.json");
  const pidFile = join(dir, "pid");
  process.env.TEST_MCP_TOKEN = "test-only-token";
  process.env.MCP_PID_FILE = pidFile;
  const serverScript = [
    'import { writeFileSync } from "node:fs";',
    `import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};`,
    `import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
    `import { ListToolsRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};`,
    "writeFileSync(process.env.MCP_PID_FILE, String(process.pid));",
    'const server = new Server({ name: "discover-test", version: "1.0.0" }, { capabilities: { tools: {} } });',
    'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "read_calendar", description: "Read upcoming events", inputSchema: { type: "object" } }] }));',
    "await server.connect(new StdioServerTransport());",
  ].join(" ");
  try {
    const serverFile = join(dir, "discovery-server.mjs");
    await writeFile(serverFile, serverScript);
    await manageMcp(
      {
        action: "add",
        server: "calendar",
        config: {
          command: process.execPath,
          args: [serverFile],
          env: { MCP_PID_FILE: "$MCP_PID_FILE" },
          timeout_ms: 5_000,
        },
      },
      undefined,
      path,
    );
    const discovered = await manageMcp({ action: "discover_tools", server: "calendar" }, undefined, path);
    assert.equal(discovered.tools?.[0]?.name, "read_calendar");
    assert.match(discovered.tools?.[0]?.description ?? "", /upcoming/);
    const firstPid = Number(await readFile(pidFile, "utf-8"));
    assert.equal(await waitForExit(firstPid), true);

    const health = await manageMcp({ action: "test", server: "calendar" }, undefined, path);
    assert.match(health.message, /healthy.*1 tools/);
    assert.equal(health.tools, undefined);
    const secondPid = Number(await readFile(pidFile, "utf-8"));
    assert.equal(await waitForExit(secondPid), true);
  } finally {
    delete process.env.TEST_MCP_TOKEN;
    delete process.env.MCP_PID_FILE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("reload rejects malformed on-disk config without replacing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-mcp-reload-"));
  const path = join(dir, "mcp-servers.json");
  try {
    await writeFile(path, JSON.stringify({ servers: { broken: { command: "node", url: "https://x.test" } } }));
    await assert.rejects(manageMcp({ action: "reload" }, undefined, path), /exactly one transport/);
    assert.match(await readFile(path, "utf-8"), /broken/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
