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
      send(res, 200, dashboardHtml, "text/html; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/assets/app.js") {
      send(res, 200, dashboardJs, "text/javascript; charset=utf-8");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/summary") {
      sendJson(res, 200, await getSummary(url.searchParams.get("refresh") === "1"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/refresh") {
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
    console.log(`JARVIS observability dashboard: http://${host}:${port}`);
    console.log(`Derived summary cache: ${observabilitySummaryPath()}`);
  });
}

const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JARVIS Observability</title>
  <style>
    :root { color-scheme: dark; --bg:#05070b; --panel:#0b1020; --panel2:#0f172a; --line:#20304f; --text:#d7e2f1; --muted:#7f91ad; --cyan:#60f6ff; --blue:#6ea8ff; --green:#7cffb2; --amber:#ffd166; --red:#ff6b8a; }
    * { box-sizing: border-box; } body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: radial-gradient(circle at 20% 0%, #11203e 0, transparent 30%), radial-gradient(circle at 100% 10%, #102b35 0, transparent 26%), var(--bg); color:var(--text); }
    .shell { max-width: 1440px; margin:0 auto; padding:28px; } header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:22px; } h1 { margin:0; letter-spacing:.08em; font-size:28px; font-weight:800; } .sub { color:var(--muted); margin-top:6px; } button { background:linear-gradient(135deg, #12345f, #0d6670); color:var(--text); border:1px solid #2d6f91; border-radius:10px; padding:10px 14px; cursor:pointer; font-weight:700; } button:hover { filter:brightness(1.2); }
    .grid { display:grid; grid-template-columns: repeat(12, 1fr); gap:16px; } .card { background:linear-gradient(180deg, rgba(15,23,42,.92), rgba(5,7,11,.92)); border:1px solid var(--line); border-radius:18px; padding:16px; box-shadow:0 18px 60px rgba(0,0,0,.28), inset 0 1px rgba(255,255,255,.04); overflow:hidden; } .span3{grid-column:span 3}.span4{grid-column:span 4}.span5{grid-column:span 5}.span6{grid-column:span 6}.span7{grid-column:span 7}.span8{grid-column:span 8}.span12{grid-column:span 12}
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.14em; } .metric { font-size:30px; font-weight:850; margin-top:6px; } .metric small { color:var(--muted); font-size:13px; font-weight:600; } h2 { margin:0 0 12px; font-size:14px; letter-spacing:.12em; text-transform:uppercase; color:#b9c7dc; } canvas { width:100%; height:250px; display:block; } .barrow { display:grid; grid-template-columns: minmax(90px, 1fr) 3fr 86px; gap:10px; align-items:center; margin:9px 0; font-size:13px; } .bar { height:8px; background:#101a2d; border:1px solid #1c3154; border-radius:99px; overflow:hidden; } .fill { height:100%; background:linear-gradient(90deg, var(--cyan), var(--blue)); box-shadow:0 0 14px rgba(96,246,255,.35); } table { width:100%; border-collapse:collapse; font-size:13px; } th { color:var(--muted); font-weight:700; text-align:left; border-bottom:1px solid var(--line); padding:8px; } td { border-bottom:1px solid rgba(32,48,79,.55); padding:8px; vertical-align:top; } .pill { display:inline-block; border:1px solid #31516f; border-radius:999px; padding:2px 7px; color:#b9d8ff; margin:0 4px 4px 0; background:#0a1527; } .muted { color:var(--muted); } .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; } .event { border-left:2px solid var(--amber); padding-left:10px; margin:10px 0; color:#d7d7c1; }
    @media (max-width: 900px) { .span3,.span4,.span5,.span6,.span7,.span8,.span12 { grid-column:span 12 } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body><div class="shell"><header><div><h1>JARVIS AI OBSERVABILITY</h1><div class="sub">Local/private usage telemetry from session JSONL. No SaaS, no transcript deletion.</div></div><button id="refresh">Refresh derived summary</button></header><main id="app" class="grid"><div class="card span12">Loading…</div></main></div><script src="/assets/app.js"></script></body>
</html>`;

const dashboardJs = String.raw`
const $ = (s, r=document) => r.querySelector(s);
const app = $('#app');
const fmt = new Intl.NumberFormat('en-US');
const money = n => n === 0 ? '$0.00' : n < .01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
const day = ms => ms ? new Date(ms).toLocaleString() : 'unknown';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const short = (s, n=70) => !s ? '' : s.length > n ? s.slice(0, n-1) + '…' : s;
function metric(label, value, sub='') { return '<section class="card span3"><div class="label">'+label+'</div><div class="metric">'+value+' <small>'+sub+'</small></div></section>'; }
function bars(title, rows, val, label) { const max = Math.max(1, ...rows.map(val)); return '<section class="card span4"><h2>'+title+'</h2>'+rows.slice(0,8).map(r => '<div class="barrow"><div title="'+esc(r.key||r.name)+'">'+esc(short(r.key||r.name,28))+'</div><div class="bar"><div class="fill" style="width:'+Math.max(2, val(r)/max*100)+'%"></div></div><div class="mono">'+label(r)+'</div></div>').join('')+'</section>'; }
function drawChart(canvas, rows) { const ctx = canvas.getContext('2d'), w = canvas.width = canvas.clientWidth*devicePixelRatio, h = canvas.height = canvas.clientHeight*devicePixelRatio; ctx.scale(devicePixelRatio, devicePixelRatio); const W=canvas.clientWidth,H=canvas.clientHeight,p=26; ctx.clearRect(0,0,W,H); const data=rows.slice(-45); const max=Math.max(1,...data.map(r=>r.tokens.total)); ctx.strokeStyle='#20304f'; ctx.lineWidth=1; for(let i=0;i<4;i++){let y=p+(H-2*p)*i/3;ctx.beginPath();ctx.moveTo(p,y);ctx.lineTo(W-p,y);ctx.stroke();} ctx.beginPath(); data.forEach((r,i)=>{const x=p+(W-2*p)*(data.length<=1?0:i/(data.length-1)); const y=H-p-(H-2*p)*r.tokens.total/max; i?ctx.lineTo(x,y):ctx.moveTo(x,y);}); ctx.strokeStyle='#60f6ff'; ctx.lineWidth=2.5; ctx.stroke(); data.forEach((r,i)=>{const x=p+(W-2*p)*(data.length<=1?0:i/(data.length-1)); const y=H-p-(H-2*p)*r.tokens.total/max; ctx.fillStyle='#7cffb2'; ctx.beginPath(); ctx.arc(x,y,2.4,0,Math.PI*2); ctx.fill();}); ctx.fillStyle='#7f91ad'; ctx.font='12px ui-monospace'; ctx.fillText(fmt.format(max)+' tok', p, 14); }
function render(s) { app.innerHTML = [
  metric('Sessions', fmt.format(s.totals.sessions), s.scannedFiles+' files'),
  metric('LLM calls', fmt.format(s.totals.usage.requests), 'assistant usage records'),
  metric('Tokens', fmt.format(s.totals.usage.tokens.total), 'in '+fmt.format(s.totals.usage.tokens.input)+' / out '+fmt.format(s.totals.usage.tokens.output)),
  metric('Est. cost', money(s.totals.usage.cost.total), 'local pi-ai estimates'),
  '<section class="card span8"><h2>Usage over time</h2><canvas id="usageChart"></canvas><div class="muted">Last '+Math.min(45,s.timeSeries.length)+' active days · generated '+new Date(s.generatedAt).toLocaleString()+'</div></section>',
  bars('Model breakdown', s.byModel, r=>r.cost.total || r.tokens.total, r=>money(r.cost.total)),
  bars('Provider breakdown', s.byProvider, r=>r.tokens.total, r=>fmt.format(r.tokens.total)),
  bars('Tool usage', s.toolUsage, r=>r.calls, r=>fmt.format(r.calls)),
  bars('Source mix', s.bySource, r=>r.sessions, r=>fmt.format(r.sessions)+' sess'),
  '<section class="card span8"><h2>Recent sessions</h2><table><thead><tr><th>Ended</th><th>Source</th><th>First user text</th><th>Model</th><th>Tokens</th><th>Tools</th><th>Cost</th></tr></thead><tbody>'+s.sessions.slice(0,30).map(x=>'<tr><td class="mono">'+esc(day(x.endedAt))+'</td><td>'+esc(x.source)+'</td><td>'+esc(short(x.firstUserText||x.id,90))+'</td><td>'+x.models.slice(0,2).map(m=>'<span class="pill">'+esc(short(m,34))+'</span>').join('')+'</td><td class="mono">'+fmt.format(x.usage.tokens.total)+'</td><td class="mono">'+fmt.format(x.toolCalls)+'</td><td class="mono">'+money(x.usage.cost.total)+'</td></tr>').join('')+'</tbody></table></section>',
  '<section class="card span4"><h2>Retry / fallback signals</h2>'+(s.retryFallbackEvents.length?s.retryFallbackEvents.slice(0,18).map(e=>'<div class="event"><div class="mono muted">'+esc(day(e.timestamp))+' · '+esc(e.type)+'</div><div>'+esc(short(e.detail,120))+'</div></div>').join(''):'<div class="muted">No obvious retry/fallback events found.</div>')+'</section>',
  '<section class="card span12"><h2>Classification scaffold</h2><div class="muted">Every session summary includes <span class="mono">classification: { status: "unclassified", labels: [] }</span> so a future local/LLM classifier can annotate turns or sessions without mutating raw transcripts.</div></section>'
].join(''); drawChart($('#usageChart'), s.timeSeries); }
async function load(refresh=false){ app.innerHTML='<div class="card span12">Loading summary…</div>'; const r=await fetch(refresh?'/api/summary?refresh=1':'/api/summary'); render(await r.json()); }
$('#refresh').addEventListener('click', ()=>load(true)); load();
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  startObservabilityServer();
}
