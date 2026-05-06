// Minimal markdown → Telegram HTML converter.
//
// Telegram's HTML parse mode supports a small set of tags:
//   <b> <strong> <i> <em> <u> <s> <a href> <code> <pre>
// Everything else must be HTML-escaped (`<`, `>`, `&` matter).
//
// We chose HTML over MarkdownV2 because MarkdownV2's escape list is a footgun:
// `.` `_` `*` `[` `]` `(` `)` `~` `` ` `` `>` `#` `+` `-` `=` `|` `{` `}` `!`
// all need to be escaped, and one missed character makes the whole send fail.
// HTML only requires escaping three characters; the rest passes through.
//
// Scope: handle ```fenced code blocks```, `inline code`, `**bold**`, `*italic*`,
// `_italic_`. Everything else is HTML-escaped and sent as-is. This is enough
// for the common cases (shell output, code snippets, emphasis) without a heavy
// markdown parser.

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Apply inline-level formatting to a piece of text known to be outside any
// fenced code block. Order: HTML-escape first (so subsequent regex literals
// don't accidentally match HTML entities), then bold/italic/inline-code.
function formatInline(text: string): string {
  let s = escapeHtml(text);
  // **bold** — non-greedy, single line
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  // *italic* — single asterisks, careful not to match the inside of a `**`
  // by requiring non-asterisk neighbors via lookarounds
  s = s.replace(/(^|[^*])\*([^\n*]+?)\*(?!\*)/g, "$1<i>$2</i>");
  // _italic_ — same shape with underscores; must not be adjacent to word chars
  // so we don't mangle snake_case identifiers
  s = s.replace(/(^|[^A-Za-z0-9_])_([^\n_]+?)_(?![A-Za-z0-9_])/g, "$1<i>$2</i>");
  // `inline code` — must not span newlines
  s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
  return s;
}

// Walk the input character-by-character finding triple-backtick fences.
// Inside fences: HTML-escape only (no inline formatting). Outside fences:
// formatInline. Unclosed fences treat the rest of the input as code.
export function markdownToTelegramHtml(input: string): string {
  const out: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const fenceStart = input.indexOf("```", cursor);
    if (fenceStart === -1) {
      // No more fences — format remaining text inline and finish.
      out.push(formatInline(input.slice(cursor)));
      break;
    }

    // Anything before the fence is regular text.
    if (fenceStart > cursor) {
      out.push(formatInline(input.slice(cursor, fenceStart)));
    }

    const afterOpen = fenceStart + 3;
    const fenceEnd = input.indexOf("```", afterOpen);

    if (fenceEnd === -1) {
      // Unclosed fence: treat the rest as a code block.
      out.push(`<pre><code>${escapeHtml(input.slice(afterOpen))}</code></pre>`);
      break;
    }

    // Skip the optional language tag and the newline that follows ```lang\n.
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
