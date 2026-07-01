// System prompt assembly.
//
// Loads the static base prompt from `~/.jarvis/prompts/system.md`, optional
// host-local adaptive voice guidance from `~/.jarvis/prompts/SOUL.md`, and
// dynamically appends a skills index + MCP server list so JARVIS always knows
// what capabilities are available without reading index files on demand.
//
// Prompt assembly is intentionally a function, not a process-start const:
// each agent run calls it so host-local prompt edits can take effect without a
// raw service restart when the running code already supports dynamic assembly.

import { buildSystemPrompt } from "./prompt-assembler.js";

export function getSystemPrompt(): string {
  return buildSystemPrompt();
}
