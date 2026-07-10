import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadMcpModule() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-mcp-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  const mcp = await import("./mcp.js");
  return { dataDir, mcp };
}

const fixture = loadMcpModule();

async function waitForMarker(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await readFile(file, "utf-8");
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for MCP test marker: ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("MCP config follows JARVIS_DATA_DIR and reports actionable JSON/shape errors", async () => {
  const { dataDir, mcp } = await fixture;
  assert.equal(mcp.MCP_CONFIG_PATH, join(dataDir, "mcp-servers.json"));

  const validPath = join(dataDir, "valid.json");
  await writeFile(
    validPath,
    JSON.stringify({ servers: { local: { command: process.execPath, args: ["--version"] } } }),
  );
  assert.equal(mcp.loadMcpServers(validPath).servers.local.command, process.execPath);

  const invalidJsonPath = join(dataDir, "invalid-json.json");
  await writeFile(invalidJsonPath, "{ definitely not JSON", "utf-8");
  assert.throws(() => mcp.loadMcpServers(invalidJsonPath), /Invalid MCP configuration.*expected valid JSON/i);

  const invalidShapePath = join(dataDir, "invalid-shape.json");
  await writeFile(
    invalidShapePath,
    JSON.stringify({ servers: { broken: { command: "node", url: "https://example.com/mcp", mystery: true } } }),
  );
  assert.throws(
    () => mcp.loadMcpServers(invalidShapePath),
    (err: unknown) => {
      assert.match((err as Error).message, /servers\.broken/i);
      assert.match((err as Error).message, /exactly one transport|unrecognized key/i);
      return true;
    },
  );
});

test("MCP content normalization caps text and omits binary payloads", async () => {
  const { mcp } = await fixture;
  const binary = "QUJD".repeat(50_000);
  const content = mcp.normalizeMcpContent([
    { type: "image", mimeType: "image/png", data: binary },
    { type: "resource", resource: { uri: "file:///sample", blob: binary } },
    { type: "text", text: "x".repeat(mcp.MCP_OUTPUT_MAX_CHARS * 2) },
  ]);

  assert.ok(content.length <= mcp.MCP_OUTPUT_MAX_CHARS);
  assert.doesNotMatch(content, /QUJDQUJDQUJD/);
  assert.match(content, /omitted MCP image/i);
  assert.match(content, /omitted binary payload/i);
  assert.match(content, /truncated/i);
});

test("MCP calls honor cancellation and close their stdio child", async () => {
  const { dataDir, mcp } = await fixture;
  const pidFile = join(dataDir, "server.pid");
  const callStartedFile = join(dataDir, "call-started");
  await mkdir(dataDir, { recursive: true });
  const serverScript = `
    import { writeFileSync } from "node:fs";
    import { Server } from "@modelcontextprotocol/sdk/server/index.js";
    import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
    import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
    writeFileSync(process.env.PID_FILE, String(process.pid));
    const server = new Server({ name: "hang-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "hang", description: "hang", inputSchema: { type: "object" } }]
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => {
      writeFileSync(process.env.CALL_STARTED_FILE, "started");
      return new Promise((resolve) =>
        setTimeout(() => resolve({ content: [{ type: "text", text: "late" }] }), 60_000)
      );
    });
    await server.connect(new StdioServerTransport());
  `;
  const controller = new AbortController();
  const call = mcp.callMcpTool(
    {
      command: process.execPath,
      args: ["--input-type=module", "-e", serverScript],
      env: { PID_FILE: pidFile, CALL_STARTED_FILE: callStartedFile },
    },
    "hang",
    {},
    controller.signal,
  );

  // Synchronize on the server actually entering the hanging tool handler.
  // This proves cancellation is in-flight and avoids coverage-speed races.
  await Promise.race([
    waitForMarker(callStartedFile),
    call.then(
      () => {
        throw new Error("MCP test call completed before its started marker");
      },
      (err: unknown) => {
        throw new Error("MCP test call failed before its started marker", { cause: err });
      },
    ),
  ]);
  controller.abort(new Error("cancel MCP test"));
  await assert.rejects(call, /cancel MCP test|abort/i);

  const pid = Number((await readFile(pidFile, "utf-8")).trim());
  const deadline = Date.now() + 3_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `MCP stdio child ${pid} should be closed after cancellation`);
});

test("MCP audit metadata never includes arbitrary argument values", async () => {
  const { mcp } = await fixture;
  const summary = mcp.summarizeMcpAuditArgs({
    server: "filesystem",
    tool: "write_file",
    arguments: { path: "/tmp/x", content: "SUPER-SECRET-WRITE-CONTENTS" },
  });
  const serialized = JSON.stringify(summary);
  assert.deepEqual(summary, {
    server: "filesystem",
    tool: "write_file",
    argument_keys: ["content", "path"],
  });
  assert.doesNotMatch(serialized, /SUPER-SECRET|\/tmp\/x/);
  assert.doesNotMatch(
    mcp.summarizeMcpAuditError(new Error("SUPER-SECRET-WRITE-CONTENTS"), {
      server: "filesystem",
      tool: "write_file",
    }),
    /SUPER-SECRET/,
  );
});

test.after(async () => {
  const { dataDir } = await fixture;
  await rm(dataDir, { recursive: true, force: true });
});
