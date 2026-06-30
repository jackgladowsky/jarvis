import { collectObservabilitySummary, observabilitySummaryPath, writeObservabilitySummary } from "./analytics.js";

const summary = await collectObservabilitySummary();
await writeObservabilitySummary(summary);
console.log(`Wrote ${observabilitySummaryPath()}`);
console.log(
  `${summary.totals.sessions} sessions · ${summary.totals.usage.requests} LLM calls · ${summary.totals.usage.tokens.total} tokens · $${summary.totals.usage.cost.total.toFixed(4)}`,
);
