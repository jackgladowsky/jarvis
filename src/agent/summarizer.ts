// Session-end summarizer — DESIGN.md §10.
//
// One job: when a session rotates, append a one-line entry to `recent.md`
// describing what that session was about. `recent.md` is the table of
// contents JARVIS reads to answer "what were we doing earlier" type
// questions (system prompt §"Read triggers").
//
// The summarizer NEVER touches the other notes (about, decisions, todo,
// projects, …). JARVIS writes those itself, in-conversation, via its tools.
// The only code-side writer to `recent.md` lives here.
//
// Context-window safety: we summarize the same trimmed view the live agent
// saw — `previousSummary` (if any) + the post-last-compaction tail — never
// the raw archived JSONL. Compaction during the session bounds this view by
// `model.contextWindow - reserve_tokens`, so a long session can never blow
// up the summarizer's prompt.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Model } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { completeSimpleWithTelemetry } from "../observability/llm-telemetry.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";
import { getApiKeyForProvider } from "./auth.js";
import * as sessions from "./session-manager.js";

// How many TOC entries to keep in `recent.md` before rolling the oldest
// over into a monthly archive file. DESIGN.md §10.
const RECENT_CAP = 30;

const SUMMARIZER_SYSTEM_PROMPT = `You are a TOC-line generator for an assistant's session log. Read the conversation context provided and output exactly ONE markdown bullet line summarizing the session — no preamble, no explanation, no formatting beyond the bullet itself.

The line MUST be in this exact shape:

- YYYY-MM-DD <part-of-day> (<session-id>): <terse summary>

Where:
- <part-of-day> is one of: morning / afternoon / evening / night.
- <session-id> is the literal session id provided to you in the prompt — copy it verbatim. This is the agent's pointer to the archived JSONL transcript at ~/.jarvis/data/sessions/archive/<session-id>.jsonl.
- <terse summary> is at most ~15 words, past tense, focused on what was DONE or DECIDED — not what was discussed.
- Preserve specific names: project names, file paths, decision keywords.
- No quotation marks around the summary, no trailing period needed.

Examples (note the session-id parenthetical):

- 2026-05-06 evening (2026-05-06_2030_a3f2): shipped Phase 4 compaction; mirrored pi's INITIAL/UPDATE prompts
- 2026-05-04 afternoon (2026-05-04_1410_b8c1): drafted hockey-cv camera mounting plan; ordered IMX296

Output ONLY the line. Nothing else.`;

function partOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Serialize messages for the summarizer's prompt. Same shape as compaction's
// serializer — we don't want pi's full convertToLlm; just enough for the
// model to read the conversation linearly.
function serialize(loaded: sessions.LoadedSession): string {
  const parts: string[] = [];
  if (loaded.previousSummary) {
    parts.push(`<earlier-summary>\n${loaded.previousSummary}\n</earlier-summary>`);
  }
  for (const m of loaded.tail) {
    const role = (m as { role?: string }).role;
    if (role === "user") {
      const c = (m as { content: string | Array<{ type: string; text?: string }> }).content;
      const text =
        typeof c === "string"
          ? c
          : c
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n");
      parts.push(`USER: ${text}`);
    } else if (role === "assistant") {
      const blocks = (m as unknown as { content: Array<Record<string, unknown>> }).content;
      const lines: string[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") lines.push(b.text);
        else if (b.type === "toolCall") {
          lines.push(`[tool: ${String(b.name ?? "")} ${JSON.stringify(b.arguments ?? {})}]`);
        }
      }
      parts.push(`ASSISTANT: ${lines.join("\n")}`);
    } else if (role === "toolResult") {
      const c = (m as { content: string | Array<{ type: string; text?: string }> }).content;
      const text =
        typeof c === "string"
          ? c
          : c
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("\n");
      parts.push(`TOOL_RESULT: ${text}`);
    }
  }
  return parts.join("\n\n");
}

async function generateLine(
  sessionId: string,
  loaded: sessions.LoadedSession,
  model: Model<any>,
  rotatedAt: Date,
): Promise<string> {
  const apiKey = await getApiKeyForProvider(model.provider);
  if (!apiKey) {
    throw new Error(`no api key for provider ${model.provider} (summarizer)`);
  }

  const conversation = serialize(loaded);
  // Pass the session id explicitly so the model can copy it verbatim into
  // the parenthetical — this is the link from recent.md back into the
  // archived JSONL.
  const promptText = `<context>\n${conversation}\n</context>\n\nSession id: ${sessionId}\nThe session ended at ${isoDate(rotatedAt)} (${partOfDay(rotatedAt)}). Generate the TOC line, copying the session id verbatim into the parenthetical.`;

  const response = await completeSimpleWithTelemetry(
    model,
    {
      systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 200 },
    {
      kind: "summarizer",
      session_id: sessionId,
      source_path: join(paths.sessionsArchive, `${sessionId}.jsonl`),
      message_ts: new Date().toISOString(),
    },
  );

  if (response.stopReason === "error") {
    throw new Error(`summarizer failed: ${response.errorMessage ?? "unknown"}`);
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  // Defensive: take only the first line, force "- " prefix if missing. The
  // model is told to output exactly one bullet, but cheap insurance.
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  if (!firstLine) throw new Error("summarizer produced empty output");
  return firstLine.startsWith("-") ? firstLine : `- ${firstLine}`;
}

// Append `line` to recent.md. If the file ends up over the cap, roll the
// overflow into archive/recent-YYYY-MM.md (current month) so the live file
// stays bounded for fast reads from the agent.
async function writeRecentLine(line: string): Promise<void> {
  await mkdir(paths.notes, { recursive: true });
  const recentPath = join(paths.notes, "recent.md");

  let existing = "";
  try {
    existing = await readFile(recentPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Newest entry on top so the agent's `read recent.md` sees recent stuff
  // without paging through history.
  const updated = `${line}\n${existing}`.trimStart() + (existing ? "" : "\n");

  // If we're over the cap, peel the oldest entries off the bottom into a
  // monthly archive file. Lines starting with "- " are entries; blank lines
  // and other content are preserved as headers.
  const lines = updated.split("\n");
  const entryIndices = lines.map((l, i) => (l.startsWith("- ") ? i : -1)).filter((i) => i >= 0);

  if (entryIndices.length > RECENT_CAP) {
    const overflowStart = entryIndices[RECENT_CAP];
    const overflow = lines.slice(overflowStart).join("\n");
    const kept = lines.slice(0, overflowStart).join("\n").replace(/\n+$/, "") + "\n";

    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const archivePath = join(paths.notes, `recent-${ym}.md`);
    let archiveExisting = "";
    try {
      archiveExisting = await readFile(archivePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await writeFile(archivePath, archiveExisting + overflow, "utf-8");
    await writeFile(recentPath, kept, "utf-8");
    return;
  }

  await writeFile(recentPath, updated, "utf-8");
}

// Idempotence marker: once a session has been summarized, write a sibling
// `.summarized` file. Re-runs (e.g. on crash recovery) skip it. Markers
// living next to the archived JSONL keep the cleanup story trivial — when
// you blow away an archive file, its marker goes too.
function markerPath(sessionId: string): string {
  return join(paths.sessionsArchive, `${sessionId}.summarized`);
}

async function alreadySummarized(sessionId: string): Promise<boolean> {
  try {
    await readFile(markerPath(sessionId), "utf-8");
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function markSummarized(sessionId: string): Promise<void> {
  await writeFile(markerPath(sessionId), new Date().toISOString(), "utf-8");
}

// Public entry. Called from the rotation path in session-manager. Best-
// effort: a failure here logs but does NOT take down the user's chat —
// they've already moved on to a new session.
export async function summarizeArchived(sessionId: string, model: Model<any>): Promise<void> {
  if (!config.session.summarize_on_rotation) return;
  if (await alreadySummarized(sessionId)) {
    log.debug("session already summarized, skipping", { sessionId });
    return;
  }

  try {
    const loaded = await sessions.loadArchived(sessionId);
    if (loaded.tail.length === 0 && !loaded.previousSummary) {
      log.debug("empty archived session, skipping", { sessionId });
      await markSummarized(sessionId);
      return;
    }
    const line = await generateLine(sessionId, loaded, model, new Date());
    await writeRecentLine(line);
    await markSummarized(sessionId);
    log.info("summarized session", { sessionId, line });
  } catch (err) {
    log.error("summarizer failed", { sessionId, err: err instanceof Error ? err.message : err });
    // Intentionally don't re-throw — rotation has already succeeded; the
    // user's next message shouldn't suffer because the TOC entry didn't land.
  }
}
