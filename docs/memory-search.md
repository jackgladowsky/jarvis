# Searchable conversation recall

JARVIS exposes a `search_memory` agent tool for natural-language questions such as “what did we decide about the database?” It is not slash-command-first: the model invokes the tool when past notes or conversation history may answer the owner’s request.

## Sources and index

The regenerable local index lives at `~/.jarvis/cache/memory-search-index.sqlite`. It uses SQLite FTS5/BM25 with the `porter unicode61` tokenizer. Its authoritative sources are:

- UTF-8 Markdown below `~/.jarvis/data/notes/`;
- user and assistant text blocks in active session JSONL; and
- user and assistant text blocks in archived session JSONL.

Tool calls, tool results, binary files, symlinks, hidden paths, secret/credential/token-named paths, oversized files, and malformed JSONL records are not indexed. Per-file bytes and document counts, query terms, result counts, individual snippets, aggregate snippets, and formatted tool output are all bounded. Results carry structured provenance plus a note line or raw session-record citation and date. Recalled text is historical, untrusted context and never becomes system instructions.

Every search reconciles source fingerprints with the index. New or changed sources are reparsed transactionally, unchanged sources are reused, and deleted or newly excluded sources are removed. The cache is safe to delete and will be rebuilt on the next search. Invalid SQLite files, incompatible schemas, and failed integrity checks are also rebuilt from authoritative sources; the obsolete JSON cache is no longer read.

## Ownership and scope

This is intentionally a trusted single-owner product, so explicit approved `owner` scope searches all host-local memory. The tool itself defaults to `current_chat`, which is bound to the authenticated Telegram chat. New sessions are prospectively recorded in `data/sessions/owners.json`; current-chat search filters on that metadata. Legacy archives without reliable chat ownership remain available only through approved owner-global search. A future multi-user product must migrate or exclude that legacy data.

## Citations and Telegram

Search tool output uses named Markdown links such as `decisions.md line 3`, backed by a structured `memory://note/...#L3` or `memory://session/...#L3` provenance URI. Telegram does not support arbitrary custom URL schemes, so the Telegram HTML renderer emits the readable name plus `(local source)` instead of leaking an unsupported raw URL. HTTP(S) links continue to render as clickable anchors.

## Deterministic evaluation

`src/memory/retrieval-eval.fixtures.ts` contains a synthetic, secret-free labeled corpus spanning durable notes and session history. `evaluateRetrieval` reports Precision@K, Recall@K, mean reciprocal rank, mean average precision, per-case metrics, and source-specific recall. The regression test runs the production FTS5 path against this corpus so ranking or isolation changes are visible before adding semantic lanes.

Run the focused baseline with:

```bash
pnpm build
node --test dist/memory/search-index.test.js dist/memory/retrieval-eval.test.js dist/lib/format.test.js
```

## Limits and follow-ups

Search remains local lexical retrieval. It handles exact terms and Porter stemming predictably, while synonyms and conceptual matches may require a second query. The maximum query length is 300 characters, at most 16 distinct terms are searched, and at most 10 bounded snippets are returned.

Local BGE embeddings, hybrid semantic fusion, OpenRouter reranking, and automatic project routing are intentionally out of scope for this phase. The evaluator and structured result/provenance interfaces are the seams for those later lanes; add them only after expanding the labeled corpus and setting explicit quality, latency, privacy, and abstention thresholds.
