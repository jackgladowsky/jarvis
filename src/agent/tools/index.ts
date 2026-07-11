// Aggregate export of the tools available to JARVIS.
//
// DESIGN.md §5 says "adding a tool is something to resist" — the original
// set was four (read/write/edit/bash). `web_search` is the deliberate fifth:
// curl-based search is unworkable (no good engine to scrape, most pages
// block curl), and Exa exposes both search and clean markdown extraction
// behind one API. The tool dispatches on input shape (URL → /contents,
// otherwise → /search) so it stays a single tool, not two.
//
// `browser_workbench` is the deliberate sixth: Playwright browser state and
// artifacts need structured guardrails that raw shell/browser scripting would
// not provide safely.
//
// New additions still get the original treatment: the model is smart, it
// can compose. Don't add a tool because something is *slightly* easier
// with one — add it only when the shell genuinely can't do the job.

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { withToolAudit } from "./audited.js";
import { bashTool } from "./bash.js";
import { browserWorkbenchTool } from "./browser-workbench.js";
import { configControlTool } from "./config-control.js";
import { editTool } from "./edit.js";
import { mcpCallTool, summarizeMcpAuditArgs, summarizeMcpAuditError } from "./mcp.js";
import { mcpManagerTool, summarizeMcpManagerAuditArgs, summarizeMcpManagerAuditError } from "./mcp-manager.js";
import { readTool } from "./read.js";
import { schedulerControlTool } from "./scheduler-control.js";
import { searchMemoryTool } from "./search-memory.js";
import { webSearchTool } from "./web-search.js";
import { writeTool } from "./write.js";

// MCP arguments are arbitrary and may contain file bodies, credentials, or
// other secrets. Audit only routing metadata and argument names, never values.
const auditedMcpCallTool = withToolAudit(mcpCallTool, {
  summarizeArgs: summarizeMcpAuditArgs,
  summarizeError: summarizeMcpAuditError,
});
const auditedMcpManagerTool = withToolAudit(mcpManagerTool, {
  summarizeArgs: summarizeMcpManagerAuditArgs,
  summarizeError: summarizeMcpManagerAuditError,
});

export const allTools: AgentTool<any>[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  webSearchTool,
  browserWorkbenchTool,
  configControlTool,
  schedulerControlTool,
  searchMemoryTool,
  auditedMcpManagerTool,
  auditedMcpCallTool,
];
