// `web_search` tool — JARVIS's only web-access tool.
//
// One tool, two modes, dispatched on input shape:
//   - http(s) URL    → POST /contents → returns the page text as markdown
//   - anything else  → POST /search   → returns titles + URLs + dates
//
// Why this exists despite DESIGN.md §5's "minimal surface" rule: `bash curl`
// is fine for cooperative pages but useless for actual search (no curl-able
// engine, and most pages now block curl outright). Exa solves both: search
// via API and clean markdown extraction for fetches. Keeping it as one
// combined tool — not `web_search` + `web_fetch` — matches the philosophy:
// the model picks behavior by passing a query or a URL, no extra knobs.
//
// Search mode intentionally requests NO contents (no highlights, no text).
// That keeps token cost low and lets the model decide whether to follow up
// with a URL fetch. Picking the wrong content mode for every search burns
// context fast — the model is smart enough to do this in two steps.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { env } from "../../config.js";
import { auditToolCall } from "../../lib/logger.js";

const schema = Type.Object({
  input: Type.String({
    description:
      "Either a natural-language search query OR an http(s) URL. " +
      "If it's a URL, fetches and returns that page's contents as markdown. " +
      "Otherwise, runs a web search and returns the top results (titles + URLs + dates).",
  }),
});

// Tuned for chat-context economy. /search returning 5 metadata-only rows is
// ~300 tokens; /contents capped at 25k chars is ~6k tokens worst case.
const SEARCH_NUM_RESULTS = 5;
const CONTENTS_MAX_CHARS = 25_000;

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface ExaSearchResult {
  title?: string;
  url: string;
  publishedDate?: string;
  author?: string;
}

interface ExaContentsResult {
  url: string;
  title?: string;
  text?: string;
}

async function exaPost<T>(path: "/search" | "/contents", body: unknown, signal: AbortSignal | undefined): Promise<T> {
  const res = await fetch(`https://api.exa.ai${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.EXA_API_KEY!,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    // Surface enough of Exa's body to diagnose 4xx (bad params, quota) without
    // dumping a giant HTML error page into the model's context.
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Exa ${path} failed: HTTP ${res.status} ${res.statusText}${errBody ? `: ${errBody.slice(0, 500)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

function formatSearchResults(results: ExaSearchResult[], query: string): string {
  if (results.length === 0) return `No results for "${query}".`;
  const lines = results.map((r, i) => {
    const title = r.title || "(untitled)";
    // Trim publishedDate to YYYY-MM-DD — full ISO timestamps are noise.
    const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
    return `${i + 1}. ${title}${date}\n   ${r.url}`;
  });
  return `Top ${results.length} results for "${query}":\n\n${lines.join("\n\n")}`;
}

function formatContentsResult(r: ExaContentsResult | undefined, url: string): string {
  if (!r || !r.text) return `Fetched ${url} but Exa returned no extractable text.`;
  const header = r.title ? `# ${r.title}\n${r.url}\n\n` : `${r.url}\n\n`;
  return header + r.text;
}

export const webSearchTool: AgentTool<typeof schema> = {
  name: "web_search",
  label: "web_search",
  description:
    "Search the web (with a query) or fetch a webpage's contents (with a URL). " +
    "Pass a natural-language query to search; pass an http(s) URL to fetch that page's text. " +
    "Search returns titles + URLs only — follow up with the URL to read a result.",
  parameters: schema,
  async execute(_id, { input }: Static<typeof schema>, signal) {
    const t0 = Date.now();
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("input must be non-empty");
    }
    // Mode is decided up front so audit log captures it even on failure.
    const mode: "search" | "contents" = isHttpUrl(trimmed) ? "contents" : "search";

    try {
      let text: string;
      if (mode === "contents") {
        // /contents takes top-level `text` (unlike /search which nests it).
        const data = await exaPost<{ results?: ExaContentsResult[] }>(
          "/contents",
          { ids: [trimmed], text: { maxCharacters: CONTENTS_MAX_CHARS } },
          signal,
        );
        text = formatContentsResult(data.results?.[0], trimmed);
      } else {
        // No `contents` requested — keep search lightweight. Model can fetch
        // a specific URL afterward if it wants the body.
        const data = await exaPost<{ results?: ExaSearchResult[] }>(
          "/search",
          { query: trimmed, numResults: SEARCH_NUM_RESULTS, type: "auto" },
          signal,
        );
        text = formatSearchResults(data.results ?? [], trimmed);
      }

      await auditToolCall({
        tool: "web_search",
        args: { input: trimmed, mode },
        outcome: "ok",
        duration_ms: Date.now() - t0,
      });

      return {
        content: [{ type: "text", text }],
        details: { mode },
      };
    } catch (err) {
      await auditToolCall({
        tool: "web_search",
        args: { input: trimmed, mode },
        outcome: "error",
        duration_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};
