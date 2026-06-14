# Web Search

Use this skill for off-host/current information and public webpage reading.

## Tool behavior

`web_search(input)` has two modes, dispatched by input shape:

- Natural-language query → Exa search, returns top 5 results as titles, URLs, and dates only.
- `http(s)` URL → Exa contents fetch, returns extracted markdown for that page.

Typical flow:

1. Search with a query.
2. Pick a promising result.
3. Fetch the URL if page contents are needed.
4. Cite or summarize from what you fetched, not just the search result title.

## When to use

Use `web_search` for:

- Current/local facts.
- Public web pages likely to block `curl`.
- Place recommendations.
- Documentation/news/research from public sites.

Use `bash curl` for:

- Internal/private URLs.
- Local services.
- APIs where credentials/network are on the host.

## Context hygiene

- Search results are metadata only; fetch pages selectively.
- Do not fetch every result by default.
- If a fetched page is irrelevant, say so and move on.
- Do not fabricate citations or live data.
