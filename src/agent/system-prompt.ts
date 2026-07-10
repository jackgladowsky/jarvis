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
import { paths } from "../paths.js";

export function getSystemPrompt(): string {
  return [
    buildSystemPrompt(),
    "## Runtime Paths",
    `- Source root: \`${paths.repo}\``,
    `- Data root: \`${paths.data}\``,
    "These resolved paths are authoritative for this process; use them instead of assuming the default ~/jarvis or ~/.jarvis locations.",
  ].join("\n\n");
}
