// Aggregate export of the four tools available to JARVIS.
//
// The set is locked at four (DESIGN.md §5): adding a tool is something to
// resist, not do speculatively. The model is competent — it can compose
// `bash` for anything not covered by read/write/edit.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

export const allTools: AgentTool<any>[] = [readTool, writeTool, editTool, bashTool];
