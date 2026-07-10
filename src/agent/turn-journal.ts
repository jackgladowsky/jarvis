import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, withFileLock } from "../lib/durable-file.js";
import { paths } from "../paths.js";

export type TurnJournalStatus = "running" | "committed" | "failed" | "cancelled" | "interrupted";

export interface ChatTurnJournal {
  id: string;
  kind: "chat";
  chat_id: number;
  session_id: string;
  prompt_sha256: string;
  prompt_bytes: number;
  image_count: number;
  status: TurnJournalStatus;
  tool_started: boolean;
  tool_names: string[];
  visible_output: boolean;
  started_at: string;
  updated_at: string;
  error?: string;
}

export interface BegunChatTurn {
  current: ChatTurnJournal;
  interrupted?: ChatTurnJournal;
  /** All still-unresolved interruptions, oldest first. */
  interruptions: ChatTurnJournal[];
}

interface PendingChatRecoveries {
  kind: "chat-recoveries";
  chat_id: number;
  turns: ChatTurnJournal[];
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function chatKey(chatId: number): string {
  return createHash("sha256").update(String(chatId)).digest("hex").slice(0, 24);
}

function activePath(chatId: number): string {
  return join(paths.turnJournalActive, `chat-${chatKey(chatId)}.json`);
}

function recoveryPath(chatId: number): string {
  return join(paths.turnJournalActive, `chat-${chatKey(chatId)}.recovery.json`);
}

function archivePath(turn: ChatTurnJournal): string {
  return join(paths.turnJournalArchive, `${turn.started_at.replace(/[:.]/g, "-")}-${turn.id}.json`);
}

async function readActive(chatId: number): Promise<ChatTurnJournal | undefined> {
  try {
    return JSON.parse(await readFile(activePath(chatId), "utf-8")) as ChatTurnJournal;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function readPendingRecoveries(chatId: number): Promise<ChatTurnJournal[]> {
  try {
    const pending = JSON.parse(await readFile(recoveryPath(chatId), "utf-8")) as PendingChatRecoveries;
    return Array.isArray(pending.turns) ? pending.turns : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writePendingRecoveries(chatId: number, turns: ChatTurnJournal[]): Promise<void> {
  await atomicWriteJson(recoveryPath(chatId), {
    kind: "chat-recoveries",
    chat_id: chatId,
    turns,
    updated_at: now(),
  } satisfies PendingChatRecoveries);
}

function appendUniqueRecovery(turns: ChatTurnJournal[], turn: ChatTurnJournal): void {
  if (!turns.some((candidate) => candidate.id === turn.id)) turns.push(turn);
}

async function archiveActive(turn: ChatTurnJournal): Promise<void> {
  await mkdir(paths.turnJournalArchive, { recursive: true });
  await atomicWriteJson(activePath(turn.chat_id), turn);
  await rename(activePath(turn.chat_id), archivePath(turn));
}

/**
 * Durably records the user turn before inference. If the prior process died,
 * its outcome is archived and returned so the runtime can warn the next agent
 * instead of treating a possibly-side-effecting turn as fresh.
 */
export async function beginChatTurn(
  chatId: number,
  sessionId: string,
  prompt: string,
  imageCount: number,
): Promise<BegunChatTurn> {
  const file = activePath(chatId);
  return withFileLock(file, async () => {
    const previous = await readActive(chatId);
    const pendingRecoveries = await readPendingRecoveries(chatId);
    const ephemeralRecoveries: ChatTurnJournal[] = [];
    if (previous) {
      if (previous.status === "running") {
        previous.status = "interrupted";
        previous.updated_at = now();
        previous.error = "process stopped before the turn was durably committed";
      } else if (previous.status === "interrupted") {
        // A prior archival attempt may have failed after the interruption was
        // recorded. Preserve the recovery warning until archival succeeds.
      }

      if (previous.status === "interrupted") {
        if (interruptedTurnHasReplayRisk(previous)) {
          // Persist the warning before archiving the active journal. A crash at
          // any later point can therefore duplicate a warning, but cannot lose
          // an unknown side-effect outcome.
          appendUniqueRecovery(pendingRecoveries, previous);
          await writePendingRecoveries(chatId, pendingRecoveries);
        } else {
          ephemeralRecoveries.push(previous);
        }
      }
      await archiveActive(previous);
    }

    const timestamp = now();
    const current: ChatTurnJournal = {
      id: randomUUID(),
      kind: "chat",
      chat_id: chatId,
      session_id: sessionId,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      prompt_bytes: Buffer.byteLength(prompt),
      image_count: imageCount,
      status: "running",
      tool_started: false,
      tool_names: [],
      visible_output: false,
      started_at: timestamp,
      updated_at: timestamp,
    };
    await atomicWriteJson(file, current);
    const interruptions = [...pendingRecoveries, ...ephemeralRecoveries].filter(
      (turn, index, all) => all.findIndex((candidate) => candidate.id === turn.id) === index,
    );
    return { current, interrupted: interruptions[0], interruptions };
  });
}

async function mutateActive(turn: ChatTurnJournal, mutate: (current: ChatTurnJournal) => void): Promise<void> {
  const file = activePath(turn.chat_id);
  await withFileLock(file, async () => {
    const current = await readActive(turn.chat_id);
    if (!current) throw new Error(`active chat turn journal disappeared: ${turn.id}`);
    if (current.id !== turn.id) {
      throw new Error(`active chat turn journal changed before boundary write: ${turn.id}`);
    }
    mutate(current);
    current.updated_at = now();
    await atomicWriteJson(file, current);
    Object.assign(turn, current);
  });
}

/** Called from the awaited tool-start event, before the tool implementation runs. */
export async function recordChatToolStart(turn: ChatTurnJournal, toolName: string): Promise<void> {
  await mutateActive(turn, (current) => {
    current.tool_started = true;
    if (!current.tool_names.includes(toolName)) current.tool_names.push(toolName);
  });
}

/** Called before invoking a callback that may expose assistant text. */
export async function recordChatVisibleOutput(turn: ChatTurnJournal): Promise<void> {
  if (turn.visible_output) return;
  await mutateActive(turn, (current) => {
    current.visible_output = true;
  });
}

export async function finishChatTurn(
  turn: ChatTurnJournal,
  status: Exclude<TurnJournalStatus, "running" | "interrupted">,
  error?: string,
): Promise<void> {
  const file = activePath(turn.chat_id);
  await withFileLock(file, async () => {
    const current = await readActive(turn.chat_id);
    if (!current) throw new Error(`active chat turn journal disappeared before commit: ${turn.id}`);
    if (current.id !== turn.id) throw new Error(`active chat turn journal changed before commit: ${turn.id}`);
    current.status = status;
    current.updated_at = now();
    current.error = error;
    Object.assign(turn, current);
    await archiveActive(current);
    if (status === "committed") await rm(recoveryPath(turn.chat_id), { force: true });
  });
}

export function interruptedTurnHasReplayRisk(turn: ChatTurnJournal | undefined): boolean {
  return Boolean(turn && (turn.tool_started || turn.visible_output));
}

export function renderInterruptedTurnWarning(turn: ChatTurnJournal): string {
  const tools = turn.tool_names.length ? ` Tools that began: ${turn.tool_names.join(", ")}.` : "";
  const boundary = interruptedTurnHasReplayRisk(turn)
    ? ` An externally visible or side-effecting boundary was crossed.${tools}`
    : " No tool-start or visible-output boundary was durably recorded, but completion was not committed.";
  return `[recovery-note: The previous process stopped before its turn was committed.${boundary} Its outcome is unknown. Verify existing state before repeating any action from that turn.]`;
}
