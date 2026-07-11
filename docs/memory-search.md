# Searchable conversation recall

JARVIS exposes a `search_memory` agent tool for natural-language questions such as “what did we decide about the database?” It is not slash-command-first: the model invokes the tool when past notes or conversation history may answer the owner’s request.

## Sources and index

The regenerable lexical cache lives at `~/.jarvis/cache/memory-search-index.json`. Its authoritative sources are:

- UTF-8 Markdown below `~/.jarvis/data/notes/`;
- user and assistant text blocks in active session JSONL; and
- user and assistant text blocks in archived session JSONL.

Tool calls, tool results, binary files, symlinks, hidden paths, secret/credential/token-named paths, oversized files, and malformed JSONL records are not indexed. Results are bounded and cite a note line or raw session record plus its date. Recalled text is historical, untrusted context and never becomes system instructions.

Every search reconciles source fingerprints with the durable cache. New or changed sources are reparsed, unchanged sources reuse cached documents, and deleted sources are removed. The cache is safe to delete and will be rebuilt on the next search.

## Ownership and scope

This is intentionally a trusted single-owner product, so the default `owner` scope searches all host-local memory. New sessions are prospectively recorded in `data/sessions/owners.json`; `current_chat` scope filters to that metadata and requires a chat id. Legacy archives remain owner-global because old transcripts do not contain reliable chat ownership. A future multi-user product must default to authenticated chat scoping and migrate or exclude legacy data.

## Limits

Search is local lexical matching rather than embeddings. It handles exact terms and phrases predictably without a native database dependency or external disclosure. Synonyms and conceptual matches may require the model to try a second, related query. The maximum query length is 300 characters, at most 16 distinct query terms are scored, and at most 10 bounded snippets are returned.
