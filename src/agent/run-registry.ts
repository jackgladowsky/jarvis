import type { Agent } from "@mariozechner/pi-agent-core";

export type AgentRunKind = "chat" | "scheduled" | "background";

export class AgentRunAbortError extends Error {
  constructor(message = "Run aborted.") {
    super(message);
    this.name = "AgentRunAbortError";
  }
}

export function isAgentRunAbortError(err: unknown): boolean {
  return err instanceof AgentRunAbortError;
}

export interface ActiveAgentRun {
  id: number;
  kind: AgentRunKind;
  key: string;
  startedAt: number;
  signal: AbortSignal;
  abortReason?: string;
  attachAgent(agent: Agent): () => void;
  abort(reason?: string): void;
  finish(): void;
  isCurrent(): boolean;
  throwIfAborted(): void;
}

interface RegistryRecord {
  id: number;
  kind: AgentRunKind;
  key: string;
  controller: AbortController;
  startedAt: number;
  agent?: Agent;
  abortReason?: string;
  settled: Promise<void>;
  resolveSettled: () => void;
}

let nextRunId = 1;

function makeKey(kind: AgentRunKind, key: string | number): string {
  return `${kind}:${String(key)}`;
}

function makeAbortError(reason?: string): AgentRunAbortError {
  return new AgentRunAbortError(reason ?? "Run aborted.");
}

export class AgentRunRegistry {
  private readonly runs = new Map<string, RegistryRecord>();

  start(kind: AgentRunKind, key: string | number): ActiveAgentRun {
    const registryKey = makeKey(kind, key);
    const previous = this.runs.get(registryKey);
    if (previous) this.abortRecord(previous, "Superseded by a newer run.");

    const controller = new AbortController();
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const record: RegistryRecord = {
      id: nextRunId++,
      kind,
      key: registryKey,
      controller,
      startedAt: Date.now(),
      settled,
      resolveSettled,
    };
    this.runs.set(registryKey, record);

    const run: ActiveAgentRun = {
      id: record.id,
      kind,
      key: registryKey,
      startedAt: record.startedAt,
      get signal() {
        return record.controller.signal;
      },
      get abortReason() {
        return record.abortReason;
      },
      attachAgent: (agent: Agent) => {
        if (!this.isCurrentRecord(record)) {
          agent.abort();
          return () => undefined;
        }
        record.agent = agent;
        const onAbort = () => agent.abort();
        record.controller.signal.addEventListener("abort", onAbort, { once: true });
        if (record.controller.signal.aborted) agent.abort();
        return () => {
          record.controller.signal.removeEventListener("abort", onAbort);
          if (record.agent === agent) record.agent = undefined;
        };
      },
      abort: (reason?: string) => this.abortRecord(record, reason),
      finish: () => this.finishRecord(record),
      isCurrent: () => this.isCurrentRecord(record),
      throwIfAborted: () => {
        if (record.controller.signal.aborted || !this.isCurrentRecord(record)) {
          throw makeAbortError(record.abortReason);
        }
      },
    };

    return run;
  }

  cancel(kind: AgentRunKind, key: string | number, reason = "Cancelled."): boolean {
    const record = this.runs.get(makeKey(kind, key));
    if (!record) return false;
    this.abortRecord(record, reason);
    return true;
  }

  abortAll(reason = "Shutting down."): number {
    const records = [...this.runs.values()];
    for (const record of records) this.abortRecord(record, reason);
    return records.length;
  }

  getActive(kind: AgentRunKind, key: string | number): ActiveAgentRun | undefined {
    const record = this.runs.get(makeKey(kind, key));
    if (!record) return undefined;
    return {
      id: record.id,
      kind: record.kind,
      key: record.key,
      startedAt: record.startedAt,
      signal: record.controller.signal,
      abortReason: record.abortReason,
      attachAgent: (agent) => {
        record.agent = agent;
        const onAbort = () => agent.abort();
        record.controller.signal.addEventListener("abort", onAbort, { once: true });
        if (record.controller.signal.aborted) agent.abort();
        return () => record.controller.signal.removeEventListener("abort", onAbort);
      },
      abort: (reason?: string) => this.abortRecord(record, reason),
      finish: () => this.finishRecord(record),
      isCurrent: () => this.isCurrentRecord(record),
      throwIfAborted: () => {
        if (record.controller.signal.aborted || !this.isCurrentRecord(record)) throw makeAbortError(record.abortReason);
      },
    };
  }

  activeCount(): number {
    return this.runs.size;
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    const pending = [...this.runs.values()].map((record) => record.settled);
    if (pending.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void Promise.allSettled(pending).then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private abortRecord(record: RegistryRecord, reason?: string): void {
    if (!record.controller.signal.aborted) {
      record.abortReason = reason;
      record.controller.abort(makeAbortError(reason));
    }
    record.agent?.abort();
  }

  private finishRecord(record: RegistryRecord): void {
    if (this.runs.get(record.key) === record) this.runs.delete(record.key);
    record.resolveSettled();
  }

  private isCurrentRecord(record: RegistryRecord): boolean {
    return this.runs.get(record.key) === record;
  }
}

export const activeAgentRuns = new AgentRunRegistry();
