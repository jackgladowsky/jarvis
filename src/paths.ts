import { homedir } from "node:os";
import { join } from "node:path";

const DATA_BASE = process.env.JARVIS_DATA_DIR ?? join(homedir(), ".jarvis");

export const paths = {
  data: DATA_BASE,
  env: join(DATA_BASE, ".env"),
  configYaml: join(DATA_BASE, "config.yaml"),
  agentsMd: join(DATA_BASE, "AGENTS.md"),
  systemPrompt: join(DATA_BASE, "prompts", "system.md"),
  sessions: join(DATA_BASE, "data", "sessions"),
  sessionsArchive: join(DATA_BASE, "data", "sessions", "archive"),
  activeSessions: join(DATA_BASE, "data", "sessions", "active.json"),
  notes: join(DATA_BASE, "data", "notes"),
  notesProjects: join(DATA_BASE, "data", "notes", "projects"),
  notesProjectsArchive: join(DATA_BASE, "data", "notes", "projects", "archive"),
  audit: join(DATA_BASE, "data", "audit.log"),
  cache: join(DATA_BASE, "cache"),
} as const;
