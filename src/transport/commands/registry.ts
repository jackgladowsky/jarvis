/**
 * Central command registry for the Telegram transport.
 *
 * Every slash command JARVIS recognizes lives here. The handler dispatch in
 * `telegram.ts` looks up the matching entry via `findCommand`, and
 * `botMenuCommands()` is sent to Telegram via `setMyCommands` on bot startup
 * so the `/` menu in Telegram shows every available command with its
 * description.
 *
 * Adding a new command: add an entry to `COMMAND_REGISTRY` below (plus an
 * `handlers/<group>.ts` file with the handler). The menu and `/help`
 * regenerate automatically.
 */
import type { Context } from "grammy";

/** A single slash command. */
export interface CommandDef {
  /** Canonical name without the leading slash. Must be ≤ 32 chars. */
  name: string;
  /** Short description shown in the Telegram menu. Must be ≤ 256 chars. */
  description: string;
  /** Grouping for `/help` output. */
  category: string;
  /** Alternate names that resolve to the same handler. */
  aliases?: readonly string[];
  /** Placeholder shown in `/help`, e.g. `[on|off]` or `<task-id>`. */
  argsHint?: string;
  /** If true, the command runs outside the per-chat lock. Use for control commands that need to interrupt a long run. */
  bypassLock?: boolean;
  /** Implementation. */
  handler: CommandHandler;
}

/** Parsed view of the command invocation. */
export interface ParsedCommand {
  name: string;
  args: string;
  parts: string[];
  raw: string;
}

/** Handler signature shared by every command. */
export type CommandHandler = (ctx: Context, parsed: ParsedCommand) => Promise<void> | void;

// Registry populated by `handlers/index.ts`. We use a mutable array so tests
// can inspect it; handlers themselves are pure.
const REGISTRY: CommandDef[] = [];

/** Register all built-in commands. Called once at module load. */
export function registerCommands(defs: readonly CommandDef[]): void {
  for (const def of defs) {
    if (REGISTRY.some((existing) => existing.name === def.name)) {
      throw new Error(`duplicate command name: ${def.name}`);
    }
    REGISTRY.push(def);
  }
}

/** Read-only view of the registry. */
export function getRegistry(): readonly CommandDef[] {
  return REGISTRY;
}

/**
 * Match a message text against the registry. Returns the resolved command
 * and a parsed view, or undefined if the text isn't a slash command or doesn't
 * match any registered command.
 *
 * Accepts `/name`, `/name@botname`, and `/name args…`. Aliases are resolved.
 */
export function findCommand(text: string): { def: CommandDef; parsed: ParsedCommand } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  // Strip leading slash + bot suffix (e.g. `/cancel@jarvisbot` → `cancel`).
  const bare = head.replace(/^\//, "").split("@")[0];
  if (!bare) return undefined;

  const def = REGISTRY.find((entry) => entry.name === bare) ?? REGISTRY.find((entry) => entry.aliases?.includes(bare));
  if (!def) return undefined;

  const args = rest.trim();
  return {
    def,
    parsed: {
      name: def.name,
      args,
      parts: args.length > 0 ? args.split(/\s+/) : [],
      raw: trimmed,
    },
  };
}

/**
 * Render `/help` output, grouped by category. If a category is given, only
 * that category is shown.
 */
export function renderHelp(filterCategory?: string): string {
  const grouped = new Map<string, CommandDef[]>();
  for (const def of REGISTRY) {
    if (filterCategory && def.category !== filterCategory) continue;
    const list = grouped.get(def.category) ?? [];
    list.push(def);
    grouped.set(def.category, list);
  }

  if (grouped.size === 0) {
    return filterCategory ? `No commands in category '${filterCategory}'.` : "No commands registered.";
  }

  const lines: string[] = ["JARVIS commands"];
  for (const [category, defs] of grouped) {
    lines.push("", `— ${category} —`);
    for (const def of defs) {
      const usage = def.argsHint ? ` ${def.argsHint}` : "";
      lines.push(`/${def.name}${usage} — ${def.description}`);
    }
  }
  return lines.join("\n");
}

/**
 * Convert the registry into the shape `bot.api.setMyCommands` expects.
 * Telegram caps the menu at 100 commands and ~4KB total payload, so we cap
 * at 30 to stay well under.
 */
export interface BotMenuEntry {
  command: string;
  description: string;
}

export function botMenuCommands(maxCommands = 30): BotMenuEntry[] {
  const out: BotMenuEntry[] = [];
  for (const def of REGISTRY) {
    if (out.length >= maxCommands) break;
    out.push({ command: def.name, description: def.description });
  }
  return out;
}
