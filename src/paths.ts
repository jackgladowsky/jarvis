// Centralized filesystem layout for JARVIS.
//
// The source/data split (DESIGN.md §7) means code at `~/jarvis/` is replaceable
// wholesale, while everything JARVIS accumulates lives at `~/.jarvis/`. Every
// data-dir read or write in the codebase goes through this module so that:
//   - the layout is documented in one place,
//   - tests and dev sandboxes can override the base via `JARVIS_DATA_DIR`,
//   - typos in subpaths fail at compile time, not runtime.

import { homedir } from "node:os";
import { join } from "node:path";

// Default to `~/.jarvis/` on the host. Override for tests or local dev with:
//   JARVIS_DATA_DIR=$PWD/.jarvis-dev pnpm start
const DATA_BASE = process.env.JARVIS_DATA_DIR ?? join(homedir(), ".jarvis");

const REPO_BASE = join(homedir(), "jarvis");

export const paths = {
  // Base of the data tree.
  data: DATA_BASE,

  // Repo root (source code).
  repo: REPO_BASE,

  // Secrets and tunables (loaded by config.ts at startup).
  env: join(DATA_BASE, ".env"),
  configYaml: join(DATA_BASE, "config.yaml"),

  // Hand-curated environment docs and the persona/system prompt.
  agentsMd: join(DATA_BASE, "AGENTS.md"),
  systemPrompt: join(DATA_BASE, "prompts", "system.md"),

  // Session JSONLs — Phase 4 wires these up. See DESIGN.md §10.
  sessions: join(DATA_BASE, "data", "sessions"),
  sessionsArchive: join(DATA_BASE, "data", "sessions", "archive"),
  activeSessions: join(DATA_BASE, "data", "sessions", "active.json"),

  // Notes — JARVIS's persistent memory. See DESIGN.md §11.
  notes: join(DATA_BASE, "data", "notes"),
  notesProjects: join(DATA_BASE, "data", "notes", "projects"),
  notesProjectsArchive: join(DATA_BASE, "data", "notes", "projects", "archive"),

  // Scheduled job state — independent persistent sessions per task.
  scheduledJobs: join(DATA_BASE, "data", "jobs"),
  scheduledJobTasks: join(DATA_BASE, "data", "jobs", "tasks.json"),
  scheduledJobSessions: join(DATA_BASE, "data", "jobs", "sessions"),
  scheduledJobNotes: join(DATA_BASE, "data", "jobs", "notes"),
  scheduledJobsLog: join(DATA_BASE, "data", "jobs", "scheduler.log"),

  // Background workers — manually launched long-running agents with isolated
  // task state and git worktrees.
  background: join(DATA_BASE, "data", "background"),
  backgroundTasks: join(DATA_BASE, "data", "background", "tasks"),
  backgroundSessions: join(DATA_BASE, "data", "background", "sessions"),
  backgroundNotes: join(DATA_BASE, "data", "background", "notes"),
  backgroundMail: join(DATA_BASE, "data", "background", "mail"),
  backgroundWorktrees: join(homedir(), "jarvis-worktrees"),

  // Autonomous goals — bounded controllers that launch/review background tasks.
  goals: join(DATA_BASE, "data", "goals"),
  goalTasks: join(DATA_BASE, "data", "goals", "tasks"),
  goalEvents: join(DATA_BASE, "data", "goals", "events"),
  goalNotes: join(DATA_BASE, "data", "goals", "notes"),

  // Safe deploy state. `scripts/safe-deploy.sh` writes a marker before the
  // delayed restart; startup consumes it and sends a back-online notice.
  deployPending: join(DATA_BASE, "data", "deploy", "pending.json"),

  // Internal notification queue. Background workers, scheduler, and deploy
  // code write events here; the main Telegram process turns them into normal
  // main-session prompts when it is alive.
  internalNotifications: join(DATA_BASE, "data", "notifications"),
  internalNotificationsArchive: join(DATA_BASE, "data", "notifications", "archive"),
  internalNotificationsHeartbeat: join(DATA_BASE, "data", "notifications", "heartbeat.json"),

  // Browser/desktop workbench state. Host-local only: persistent browser
  // profile, downloads, screenshots, and machine-readable run artifacts.
  workbench: join(DATA_BASE, "data", "workbench"),
  workbenchProfile: join(DATA_BASE, "data", "workbench", "profile"),
  workbenchDownloads: join(DATA_BASE, "data", "workbench", "downloads"),
  workbenchScreenshots: join(DATA_BASE, "data", "workbench", "screenshots"),
  workbenchArtifacts: join(DATA_BASE, "data", "workbench", "artifacts"),

  // Append-only audit log of every tool call. See DESIGN.md §13.
  audit: join(DATA_BASE, "data", "audit.log"),

  // Regenerable cache — safe to delete.
  cache: join(DATA_BASE, "cache"),
} as const;
