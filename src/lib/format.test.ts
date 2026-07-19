import test from "node:test";
import assert from "node:assert/strict";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "./format.js";

test("markdownToTelegramHtml escapes unsafe HTML and formats common markdown", () => {
  const html = markdownToTelegramHtml("# Title <x>\n- **bold** and `code`\nSee [site](https://example.com).");

  assert.match(html, /<b>Title &lt;x&gt;<\/b>/);
  assert.match(html, /• <b>bold<\/b> and <code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com">site<\/a>/);
});

test("markdownToTelegramHtml renders memory citations as named safe Telegram fallbacks", () => {
  const html = markdownToTelegramHtml(
    "[decisions.md line 3](memory://note/decisions.md#L3) and [session abc line 9](memory://session/abc#L9)",
  );

  assert.equal(html, "decisions.md line 3 <i>(local source)</i> and session abc line 9 <i>(local source)</i>");
  assert.doesNotMatch(html, /memory:\/\//);
  assert.doesNotMatch(html, /href=/);
});

test("markdownToTelegramHtml does not turn unsafe link attributes into Telegram HTML", () => {
  const html = markdownToTelegramHtml('[click](https://example.com/" onmouseover="x)');
  assert.doesNotMatch(html, /<a href=/);
  assert.match(html, /&quot;|"/);
});

test("markdownToTelegramHtml preserves fenced code without inline formatting", () => {
  const html = markdownToTelegramHtml("```ts\nconst x = '<tag>';\n```\n**done**");

  assert.match(html, /<pre><code>const x = '&lt;tag&gt;';\n<\/code><\/pre>/);
  assert.match(html, /<b>done<\/b>/);
});

test("splitTelegramMarkdown prefers paragraph boundaries and splits oversized text", () => {
  assert.deepEqual(splitTelegramMarkdown("one\n\ntwo", 7), ["one", "two"]);
  const chunks = splitTelegramMarkdown("a ".repeat(20).trim(), 12);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
});
