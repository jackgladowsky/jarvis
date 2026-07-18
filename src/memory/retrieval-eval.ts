export interface LabeledRetrievalCase {
  id: string;
  query: string;
  relevantCitations: string[];
  source: "note" | "session" | "mixed";
}

export interface RankedCitation {
  citation: string;
}

export interface RetrievalCaseMetrics {
  id: string;
  hits: number;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  averagePrecision: number;
}

export interface RetrievalEvalMetrics {
  cases: number;
  k: number;
  precisionAtK: number;
  recallAtK: number;
  meanReciprocalRank: number;
  meanAveragePrecision: number;
  bySource: Record<"note" | "session" | "mixed", { cases: number; recallAtK: number }>;
  perCase: RetrievalCaseMetrics[];
}

/**
 * Score a deterministic, explicitly labeled retrieval run. Callers own the
 * corpus and ranking implementation, which keeps this usable for future dense
 * or reranking lanes without changing the lexical baseline metrics.
 */
export async function evaluateRetrieval(
  cases: LabeledRetrievalCase[],
  retrieve: (query: string, k: number) => Promise<RankedCitation[]>,
  k = 5,
): Promise<RetrievalEvalMetrics> {
  if (!Number.isSafeInteger(k) || k < 1) throw new Error("evaluation k must be a positive integer");
  if (!cases.length) throw new Error("evaluation requires at least one labeled case");
  const seenIds = new Set<string>();
  const perCase: RetrievalCaseMetrics[] = [];

  for (const item of cases) {
    if (!item.id || seenIds.has(item.id)) throw new Error(`evaluation case id must be unique: ${item.id}`);
    if (!item.query.trim() || !item.relevantCitations.length)
      throw new Error(`evaluation case is unlabeled: ${item.id}`);
    seenIds.add(item.id);
    const relevant = new Set(item.relevantCitations);
    if (relevant.size !== item.relevantCitations.length) throw new Error(`duplicate relevance label: ${item.id}`);
    const ranked = (await retrieve(item.query, k)).slice(0, k);
    let hits = 0;
    let reciprocalRank = 0;
    let precisionSum = 0;
    ranked.forEach((result, index) => {
      if (!relevant.has(result.citation)) return;
      hits += 1;
      if (!reciprocalRank) reciprocalRank = 1 / (index + 1);
      precisionSum += hits / (index + 1);
    });
    perCase.push({
      id: item.id,
      hits,
      precisionAtK: hits / k,
      recallAtK: hits / relevant.size,
      reciprocalRank,
      averagePrecision: precisionSum / relevant.size,
    });
  }

  const average = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const bySource = Object.fromEntries(
    (["note", "session", "mixed"] as const).map((source) => {
      const matching = cases
        .map((item, index) => ({ item, metric: perCase[index]! }))
        .filter(({ item }) => item.source === source);
      return [
        source,
        {
          cases: matching.length,
          recallAtK: matching.length ? average(matching.map(({ metric }) => metric.recallAtK)) : 0,
        },
      ];
    }),
  ) as RetrievalEvalMetrics["bySource"];

  return {
    cases: cases.length,
    k,
    precisionAtK: average(perCase.map((metric) => metric.precisionAtK)),
    recallAtK: average(perCase.map((metric) => metric.recallAtK)),
    meanReciprocalRank: average(perCase.map((metric) => metric.reciprocalRank)),
    meanAveragePrecision: average(perCase.map((metric) => metric.averagePrecision)),
    bySource,
    perCase,
  };
}
