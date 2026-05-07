// Config loader. Two sources, both loaded and frozen at startup:
//
//   1. `~/.jarvis/config.yaml`  — non-secret tunables, parsed and zod-validated.
//   2. `process.env`            — secrets (TELEGRAM_BOT_TOKEN, etc.), populated
//                                 by systemd's EnvironmentFile= in production
//                                 or `node --env-file=...` in local dev.
//
// Principles (DESIGN.md §8):
//   - No defaults in code. Every tunable must be present in config.yaml.
//   - Fail fast. Invalid config blocks startup with a clear zod error.
//   - Frozen at startup. Restart the service to apply changes.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { paths } from "./paths.js";

// Schema mirrors config.yaml.example exactly. Any drift between the example
// and this schema is a bug — the example is documentation, this is enforcement.
const ConfigSchema = z.object({
  agent: z.object({
    provider: z.enum(["codex", "anthropic"]),
    model: z.string().min(1),
  }),
  session: z.object({
    inactivity_threshold_minutes: z.number().int().positive(),
    max_duration_hours: z.number().positive(),
    summarize_on_rotation: z.boolean(),
    announce_new_session: z.boolean(),
  }),
  // Compaction settings mirror pi-coding-agent's defaults. See DESIGN.md §10.
  compaction: z.object({
    enabled: z.boolean(),
    reserve_tokens: z.number().int().positive(),
    keep_recent_tokens: z.number().int().positive(),
  }),
  tools: z.object({
    bash: z.object({
      default_timeout_seconds: z.number().int().positive(),
      max_timeout_seconds: z.number().int().positive(),
    }),
  }),
  telegram: z.object({
    show_typing: z.boolean(),
    long_tool_call_seconds: z.number().int().positive(),
    parse_mode: z.enum(["none", "MarkdownV2", "HTML"]),
  }),
  logging: z.object({
    audit_log_enabled: z.boolean(),
    audit_log_max_value_bytes: z.number().int().positive(),
    audit_log_redact_patterns: z.boolean(),
    level: z.enum(["debug", "info", "warn", "error"]),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

// Env vars are validated separately. Secrets only — never put tunables here.
const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  // Optional because the anthropic provider doesn't need it, and vice versa.
  CODEX_OAUTH_CREDS_PATH: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Required: powers the `web_search` tool. Search and page-fetch both go
  // through Exa — without this key the tool throws on every call. Treated
  // as load-bearing rather than optional so startup fails fast if missing.
  EXA_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

function loadConfig(): Config {
  const raw = parseYaml(readFileSync(paths.configYaml, "utf-8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${paths.configYaml}:\n${parsed.error.toString()}`,
    );
  }
  return parsed.data;
}

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid env (check ${paths.env}):\n${parsed.error.toString()}`,
    );
  }
  return parsed.data;
}

// Frozen at module load. Anything that imports `config` or `env` gets a
// snapshot. To change a value, edit the file and restart.
export const config: Readonly<Config> = Object.freeze(loadConfig());
export const env: Readonly<Env> = Object.freeze(loadEnv());
