// Loads the system prompt verbatim from `~/.jarvis/prompts/system.md` at
// process startup. There is no dynamic injection — what's in the file is
// exactly what the agent gets as its system message every turn.
//
// See DESIGN.md §4 / §11 for the rationale: a static prompt makes the
// session-start token budget predictable and keeps behavior fully specified
// by one editable file.
//
// JARVIS itself can edit this file via its tools, but changes only take
// effect after a service restart (the export below is read once at boot).

import { readFileSync } from "node:fs";
import { paths } from "../paths.js";

export const systemPrompt: string = readFileSync(paths.systemPrompt, "utf-8");
