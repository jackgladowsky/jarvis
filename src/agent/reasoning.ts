import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@mariozechner/pi-ai";
import { paths } from "../paths.js";
import { log } from "../lib/logger.js";

export type ReasoningLevel = Extract<ModelThinkingLevel, "off" | "low" | "medium" | "high">;

const RUNTIME_REASONING_PATH = join(paths.data, "runtime-reasoning.json");
const DEFAULT_REASONING_LEVEL: ReasoningLevel = "off";

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === "off" || value === "low" || value === "medium" || value === "high";
}

function loadRuntimeReasoning(): ReasoningLevel {
  try {
    if (!existsSync(RUNTIME_REASONING_PATH)) return DEFAULT_REASONING_LEVEL;
    const parsed = JSON.parse(readFileSync(RUNTIME_REASONING_PATH, "utf-8")) as { level?: unknown };
    return isReasoningLevel(parsed.level) ? parsed.level : DEFAULT_REASONING_LEVEL;
  } catch (err) {
    log.warn("failed to load runtime reasoning level", { err: String(err) });
    return DEFAULT_REASONING_LEVEL;
  }
}

function saveRuntimeReasoning(level: ReasoningLevel): void {
  try {
    mkdirSync(dirname(RUNTIME_REASONING_PATH), { recursive: true });
    writeFileSync(RUNTIME_REASONING_PATH, JSON.stringify({ level }, null, 2) + "\n", "utf-8");
  } catch (err) {
    log.warn("failed to persist runtime reasoning level", { err: String(err) });
  }
}

export let reasoningLevel: ReasoningLevel = loadRuntimeReasoning();

export function getReasoningLevel(): ReasoningLevel {
  return reasoningLevel;
}

export function switchReasoningLevel(level: ReasoningLevel): ReasoningLevel {
  reasoningLevel = level;
  saveRuntimeReasoning(level);
  return reasoningLevel;
}

export function parseReasoningLevel(value: string): ReasoningLevel | undefined {
  const normalized = value.trim().toLowerCase();
  if (["", "status", "show"].includes(normalized)) return undefined;
  if (["off", "false", "0", "stop", "none"].includes(normalized)) return "off";
  if (["on", "true", "1"].includes(normalized)) return "medium";
  if (isReasoningLevel(normalized)) return normalized;
  return undefined;
}
