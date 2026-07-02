/**
 * Shared command state — bits of mutable state that the registry handlers
 * need but `telegram.ts` also touches on its hot path. Centralizing here
 * avoids the handlers-from-telegram inversion.
 */
import type { StatusMode } from "../../../agent/runtime.js";

const statusModes = new Map<number, Exclude<StatusMode, "off">>();

export function getStatusMode(chatId: number): StatusMode {
  return statusModes.get(chatId) ?? "off";
}

export function setStatusMode(chatId: number, mode: StatusMode): void {
  if (mode === "off") statusModes.delete(chatId);
  else statusModes.set(chatId, mode);
}

const sttBenchmarkNext = new Set<number>();

export function markSttBenchmarkNext(chatId: number): void {
  sttBenchmarkNext.add(chatId);
}

export function consumeSttBenchmarkNext(chatId: number): boolean {
  return sttBenchmarkNext.delete(chatId);
}

// ── Stop button tracking ──────────────────────────────────────────────────
// Maps a chat to the message ID that currently has the [⏹ Stop] button
// attached. The callback handler and the run-completion handler both use this
// to know which message to edit (strip the keyboard or delete).
const stopButtonMessages = new Map<number, number>();

export function setStopButtonMessage(chatId: number, messageId: number): void {
  stopButtonMessages.set(chatId, messageId);
}

export function getStopButtonMessage(chatId: number): number | undefined {
  return stopButtonMessages.get(chatId);
}

export function clearStopButtonMessage(chatId: number): number | undefined {
  const id = stopButtonMessages.get(chatId);
  stopButtonMessages.delete(chatId);
  return id;
}

// ── Pending background answer ──────────────────────────────────────────────
// When Jack taps [🧑 Answer yourself] on a background task notification,
// the next message he sends should be relayed to the worker via
// `answerBackgroundTask` instead of going to the normal agent pipeline.
const pendingBackgroundAnswers = new Map<number, string>();

export function setPendingBackgroundAnswer(chatId: number, taskId: string): void {
  pendingBackgroundAnswers.set(chatId, taskId);
}

export function consumePendingBackgroundAnswer(chatId: number): string | undefined {
  const taskId = pendingBackgroundAnswers.get(chatId);
  pendingBackgroundAnswers.delete(chatId);
  return taskId;
}
