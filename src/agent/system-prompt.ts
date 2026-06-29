// System prompt assembly.
//
// Loads the static base prompt from `~/.jarvis/prompts/system.md` and
// dynamically appends a skills index + MCP server list so JARVIS always
// knows what capabilities are available without reading index files on
// demand.
//
// The base prompt remains the authoritative identity and rules. The
// appended sections are purely informational reference — they don't change
// behaviour, they just make skills/MCP discoverable at zero tool-call cost.
//
// Rebuilt on every import (once at startup). Changes to skills or MCP
// config require a service restart to take effect.

import { buildSystemPrompt } from "./prompt-assembler.js";

export const systemPrompt: string = buildSystemPrompt();
