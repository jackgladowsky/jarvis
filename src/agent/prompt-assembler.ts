// Dynamic system prompt assembly.
//
// Takes the static base prompt (`~/.jarvis/prompts/system.md`), optional
// host-local adaptive voice guidance (`~/.jarvis/prompts/SOUL.md`), and
// appends live-generated sections for available skills and MCP servers so
// JARVIS always knows what capabilities are available without reading index
// files on demand.
//
// The base prompt is still the authoritative identity and rules. SOUL.md is a
// narrow host-local voice/personality memory; skills/MCP sections are
// informational reference.
//
// Re-reads prompt/skills/MCP state every time it's called so host-local prompt
// edits can affect the next agent run without a raw service restart.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { paths } from "../paths.js";
import { log } from "../lib/logger.js";

export interface PromptAssemblyPaths {
  systemPrompt: string;
  adaptiveVoicePrompt: string;
  sourceSkills: string;
  localSkills: string;
  mcpConfig: string;
}

function defaultPromptAssemblyPaths(): PromptAssemblyPaths {
  return {
    systemPrompt: paths.systemPrompt,
    adaptiveVoicePrompt: paths.adaptiveVoicePrompt,
    sourceSkills: join(paths.repo, "skills"),
    localSkills: join(paths.data, "skills"),
    mcpConfig: join(paths.data, "mcp-servers.json"),
  };
}

// ─── Skill index ──────────────────────────────────────────────────────────

interface SkillEntry {
  slug: string;
  title: string;
  description: string;
  source: "source" | "host-local";
}

function extractSkillMeta(skillDir: string): SkillEntry | null {
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;

  try {
    const content = readFileSync(skillPath, "utf-8");
    const lines = content.split("\n");

    // Title: first `# Title` line
    const titleLine = lines.find((l) => l.startsWith("# "));
    const title = titleLine ? titleLine.slice(2).trim() : basename(skillDir);

    // Description: first non-empty, non-heading, non-code line after title
    let description = "";
    let foundTitle = false;
    for (const line of lines) {
      if (line.startsWith("# ")) {
        foundTitle = true;
        continue;
      }
      if (!foundTitle) continue;
      if (line.trim() === "" || line.startsWith("```") || line.startsWith("#")) continue;
      description = line.replace(/^[#>\s]*/, "").trim();
      break;
    }

    return { slug: basename(skillDir), title, description, source: "source" };
  } catch {
    return null;
  }
}

function scanSkillTree(baseDir: string, source: "source" | "host-local"): SkillEntry[] {
  if (!existsSync(baseDir)) return [];

  const entries: SkillEntry[] = [];
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = extractSkillMeta(join(baseDir, entry.name));
      if (meta) {
        meta.source = source;
        entries.push(meta);
      }
    }
  } catch (err) {
    log.warn("failed to scan skill tree", { dir: baseDir, err: String(err) });
  }
  return entries;
}

function buildSkillsPrompt(sourceSkillsDir: string, localSkillsDir: string): string {
  const sourceSkills = scanSkillTree(sourceSkillsDir, "source");
  const localSkills = scanSkillTree(localSkillsDir, "host-local");

  const allSkills = [...sourceSkills, ...localSkills];
  if (allSkills.length === 0) return "";

  const parts: string[] = ["## Skills"];

  // Group by source
  const grouped: Record<string, SkillEntry[]> = {};
  for (const skill of allSkills) {
    const key = skill.source === "source" ? "Source (repo)" : "Host-local";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(skill);
  }

  for (const [groupName, skills] of Object.entries(grouped)) {
    parts.push(`\n### ${groupName}`);
    for (const skill of skills.sort((a, b) => a.slug.localeCompare(b.slug))) {
      const desc = skill.description ? ` — ${skill.description}` : "";
      parts.push(`- \`${skill.slug}\`${desc}`);
    }
  }

  parts.push(
    "",
    `Read the relevant \`SKILL.md\` (via the \`read\` tool) before doing substantial work in that area. Do not load every skill by default.`,
  );

  return parts.join("\n");
}

// ─── Host-local adaptive voice memory ─────────────────────────────────────

function readOptionalPromptFile(filePath: string, label: string): string {
  if (!existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch (err) {
    log.warn(`failed to read ${label}`, { path: filePath, err: String(err) });
    return "";
  }
}

function buildAdaptiveVoicePrompt(adaptiveVoicePromptPath: string): string {
  const content = readOptionalPromptFile(adaptiveVoicePromptPath, "adaptive voice prompt");
  if (!content) return "";

  return [
    "## Adaptive Voice Memory",
    "Host-local file: `~/.jarvis/prompts/SOUL.md`.",
    "These are concise style preferences learned over time. Treat them as current voice guidance unless they conflict with higher-priority safety, product, or explicit user instructions.",
    "",
    content,
  ].join("\n");
}

// ─── MCP server index ─────────────────────────────────────────────────────

function buildMcpPrompt(mcpConfigPath: string): string {
  if (!existsSync(mcpConfigPath)) return "";

  try {
    const raw = readFileSync(mcpConfigPath, "utf-8");
    const config = JSON.parse(raw) as { servers?: Record<string, { command?: string; url?: string }> };
    const servers = config.servers;
    if (!servers || Object.keys(servers).length === 0) return "";

    const parts: string[] = ["## MCP Servers"];
    parts.push("The following MCP servers are available. Use `mcp_call` with the server name to invoke their tools.");

    for (const [name, cfg] of Object.entries(servers).sort()) {
      const transport = cfg.url ? "HTTP" : "stdio";
      parts.push(`- \`${name}\` (${transport})`);
    }

    return parts.join("\n");
  } catch (err) {
    log.warn("failed to read MCP server config", { err: String(err) });
    return "";
  }
}

// ─── Assembled prompt ─────────────────────────────────────────────────────

export function buildSystemPrompt(assemblyPaths: PromptAssemblyPaths = defaultPromptAssemblyPaths()): string {
  const basePrompt = readFileSync(assemblyPaths.systemPrompt, "utf-8").trim();
  const sections: string[] = [basePrompt];

  const adaptiveVoicePrompt = buildAdaptiveVoicePrompt(assemblyPaths.adaptiveVoicePrompt);
  if (adaptiveVoicePrompt) sections.push(adaptiveVoicePrompt);

  const skillsPrompt = buildSkillsPrompt(assemblyPaths.sourceSkills, assemblyPaths.localSkills);
  if (skillsPrompt) sections.push(skillsPrompt);

  const mcpPrompt = buildMcpPrompt(assemblyPaths.mcpConfig);
  if (mcpPrompt) sections.push(mcpPrompt);

  return sections.join("\n\n");
}
