// Minimal markdown → Telegram HTML converter plus Telegram-sized chunking.
//
// Telegram's HTML parse mode supports a small set of tags:
//   <b> <strong> <i> <em> <u> <s> <a href> <code> <pre>
// Everything else must be HTML-escaped (`<`, `>`, `&` matter).
//
// We use HTML over MarkdownV2 because MarkdownV2's escape list is a footgun.
// This intentionally handles the markdown shapes JARVIS commonly emits:
// headings, bullets, links, fenced code, inline code, bold, and italic.

export const TELEGRAM_CHUNK_SOFT_LIMIT = 3200;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatInline(text: string): string {
  let s = escapeHtml(text);

  // Telegram only permits HTTP(S) and tg:// links. Keep host-local memory
  // citations named, but render them as a safe local-source label instead of
  // sending an unsupported (and ugly) memory:// URL to the Bot API.
  s = s.replace(/\[([^\]\n]+?)\]\(memory:\/\/(?:note|session)\/[A-Za-z0-9%._~/-]+#L\d+\)/g, "$1 <i>(local source)</i>");

  // [label](https://example.com) → <a href="...">label</a>. Quotes and angle
  // brackets are excluded so generated href attributes cannot be escaped.
  s = s.replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)"<>]+)\)/g, '<a href="$2">$1</a>');

  // **bold** — non-greedy, single line.
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  // *italic* — single asterisks, careful not to match the inside of `**`.
  s = s.replace(/(^|[^*])\*([^\n*]+?)\*(?!\*)/g, "$1<i>$2</i>");
  // _italic_ — avoid snake_case identifiers.
  s = s.replace(/(^|[^A-Za-z0-9_])_([^\n_]+?)_(?![A-Za-z0-9_])/g, "$1<i>$2</i>");
  // `inline code` — must not span newlines.
  s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");

  return s;
}

function formatMarkdownLine(line: string): string {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) return `<b>${formatInline(heading[2])}</b>`;

  const bullet = line.match(/^\s*[-*]\s+(.+)$/);
  if (bullet) return `• ${formatInline(bullet[1])}`;

  const numbered = line.match(/^\s*(\d+[.)])\s+(.+)$/);
  if (numbered) return `${numbered[1]} ${formatInline(numbered[2])}`;

  return formatInline(line);
}

function formatMarkdownBlock(text: string): string {
  return text.split("\n").map(formatMarkdownLine).join("\n");
}

// Walk the input character-by-character finding triple-backtick fences.
// Inside fences: HTML-escape only (no inline formatting). Outside fences:
// format common markdown into Telegram-safe HTML.
export function markdownToTelegramHtml(input: string): string {
  const out: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const fenceStart = input.indexOf("```", cursor);
    if (fenceStart === -1) {
      out.push(formatMarkdownBlock(input.slice(cursor)));
      break;
    }

    if (fenceStart > cursor) {
      out.push(formatMarkdownBlock(input.slice(cursor, fenceStart)));
    }

    const afterOpen = fenceStart + 3;
    const fenceEnd = input.indexOf("```", afterOpen);

    if (fenceEnd === -1) {
      out.push(`<pre><code>${escapeHtml(input.slice(afterOpen))}</code></pre>`);
      break;
    }

    let codeStart = afterOpen;
    const newlineIdx = input.indexOf("\n", afterOpen);
    if (newlineIdx !== -1 && newlineIdx < fenceEnd) {
      codeStart = newlineIdx + 1;
    }
    const code = input.slice(codeStart, fenceEnd);
    out.push(`<pre><code>${escapeHtml(code)}</code></pre>`);

    cursor = fenceEnd + 3;
  }

  return out.join("");
}

function splitOversizedPart(part: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let rest = part.trim();
  while (rest.length > maxChars) {
    const candidates = [
      rest.lastIndexOf("\n", maxChars),
      rest.lastIndexOf(". ", maxChars),
      rest.lastIndexOf(" ", maxChars),
    ].filter((idx) => idx > maxChars * 0.5);
    const cut = candidates.length > 0 ? Math.max(...candidates) + 1 : maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Split raw markdown before formatting so we don't cut generated HTML tags in
// half. Prefer paragraph boundaries; fall back to sentence/space boundaries.
export function splitTelegramMarkdown(input: string, maxChars = TELEGRAM_CHUNK_SOFT_LIMIT): string[] {
  const parts = input.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.length > maxChars) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      chunks.push(...splitOversizedPart(trimmed, maxChars));
      continue;
    }

    const candidate = current ? `${current}\n\n${trimmed}` : trimmed;
    if (candidate.length > maxChars && current) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [""];
}
