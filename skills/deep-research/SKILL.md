# Deep Research

Use this skill for multi-source research, comparisons, investigations, and questions where current evidence matters.

## Workflow

1. Restate the research target briefly.
2. Identify likely source types: docs, primary sources, reputable articles, repos, changelogs, filings, etc.
3. Search broadly, then fetch selectively.
4. Prefer primary sources over summaries.
5. Track uncertainties and conflicts.
6. Synthesize into a concise answer with tradeoffs and caveats.

For long research likely to exceed about 30 seconds, spawn a background worker unless the owner asked to keep it inline.

## Source handling

- Search result titles are not evidence; fetch the page before relying on it.
- Prefer dates when recency matters.
- Distinguish facts, interpretations, and recommendations.
- If sources conflict, say what conflicts and which source you trust more.
- Do not pad with weak sources.

## Output shape

```markdown
Bottom line: <answer>

Evidence:

- <source-backed point>
- <source-backed point>

Caveats:

- <uncertainty or limitation>

My call: <recommendation, if appropriate>
```

Keep it as short as the question allows. Deep research does not require deep suffering.
