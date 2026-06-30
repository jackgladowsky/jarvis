import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import {
  collectObservabilitySummary,
  loadStoredObservabilitySummary,
  observabilitySummaryPath,
  writeObservabilitySummary,
} from "./analytics.js";

const DEFAULT_HOST = process.env.JARVIS_OBSERVABILITY_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.JARVIS_OBSERVABILITY_PORT ?? "8765");

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

async function getSummary(refresh: boolean): Promise<unknown> {
  if (!refresh) {
    const stored = await loadStoredObservabilitySummary();
    if (stored) return stored;
  }
  const summary = await collectObservabilitySummary();
  await writeObservabilitySummary(summary);
  return summary;
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) return notFound(res);
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      send(
        res,
        200,
        "JARVIS observability UI now lives in apps/observability. Run `pnpm observability:serve` for the Next.js dashboard.\n",
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/summary") {
      sendJson(res, 200, await getSummary(url.searchParams.get("refresh") === "1"));
      return;
    }
    if (req.method === "POST" && (url.pathname === "/api/refresh" || url.pathname === "/api/summary")) {
      sendJson(res, 200, await getSummary(true));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, summaryPath: observabilitySummaryPath() });
      return;
    }
    notFound(res);
  } catch (err: unknown) {
    sendJson(res, 500, { error: "internal_error", message: err instanceof Error ? err.message : String(err) });
  }
}

export function startObservabilityServer(host = DEFAULT_HOST, port = DEFAULT_PORT): void {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port, host, () => {
    console.log(`JARVIS observability API: http://${host}:${port}`);
    console.log("Dashboard: pnpm observability:serve");
    console.log(`Derived summary cache: ${observabilitySummaryPath()}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startObservabilityServer();
}
