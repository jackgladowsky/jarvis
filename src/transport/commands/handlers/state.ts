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
