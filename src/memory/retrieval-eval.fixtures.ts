import type { LabeledRetrievalCase } from "./retrieval-eval.js";

export interface RetrievalFixtureNote {
  path: string;
  text: string;
}

export interface RetrievalFixtureSession {
  id: string;
  chatId: number;
  messages: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
}

/** Secret-free synthetic regression corpus; citations intentionally pin lines. */
export const retrievalRegressionCorpus: {
  notes: RetrievalFixtureNote[];
  sessions: RetrievalFixtureSession[];
  cases: LabeledRetrievalCase[];
} = {
  notes: [
    {
      path: "projects/aurora.md",
      text: "Aurora deployments use canary rings and automatic rollback before broad release.\n",
    },
    {
      path: "decisions.md",
      text: "The local memory lexical index uses SQLite FTS5 for bounded private search.\n",
    },
    {
      path: "preferences.md",
      text: "Keep Telegram answers concise and put the answer first.\n",
    },
  ],
  sessions: [
    {
      id: "garden-history",
      chatId: 42,
      messages: [
        { role: "user", text: "What watering schedule did we pick for the tomatoes?", timestamp: 1_767_225_600_000 },
        {
          role: "assistant",
          text: "Water the tomato beds deeply every three mornings unless rain exceeds one inch.",
          timestamp: 1_767_225_601_000,
        },
      ],
    },
  ],
  cases: [
    {
      id: "durable-project-note",
      query: "Aurora canary rollback",
      relevantCitations: ["projects/aurora.md#L1"],
      source: "note",
    },
    {
      id: "durable-decision-note",
      query: "memory lexical SQLite FTS5",
      relevantCitations: ["decisions.md#L1"],
      source: "note",
    },
    {
      id: "session-history",
      query: "tomato watering every mornings",
      relevantCitations: ["session:garden-history#L1", "session:garden-history#L2"],
      source: "session",
    },
  ],
};
