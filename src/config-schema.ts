import { z } from "zod";

// Schema mirrors config.yaml.example exactly. Any drift between the example
// and this schema is a bug — the example is documentation, this is enforcement.
export const ConfigSchema = z.object({
  agent: z.object({
    provider: z.enum(["codex", "anthropic", "openrouter"]),
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
    model_favorites: z
      .array(
        z.object({
          label: z.string(),
          provider: z.enum(["codex", "anthropic", "openrouter"]),
          model_id: z.string(),
        }),
      )
      .optional(),
  }),
  stt: z.object({
    provider: z.enum(["disabled", "local-whisper-cpp"]),
    local_whisper_cpp: z.object({
      whisper_binary_path: z.string().min(1),
      model_path: z.string().min(1),
      ffmpeg_path: z.string().min(1).nullable(),
      max_audio_mb: z.number().int().positive(),
      timeout_seconds: z.number().int().positive(),
    }),
  }),
  scheduler: z.object({
    enabled: z.boolean(),
    timezone: z.string().min(1),
    telegram_chat_id: z.number().int(),
    tasks: z.array(
      z.object({
        id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
        name: z.string().min(1),
        schedule: z.string().min(1),
        prompt: z.string().min(1),
        notify: z.enum(["always", "on_issue", "never"]),
        provider: z.enum(["codex", "anthropic", "openrouter"]).optional(),
        model: z.string().min(1).optional(),
      }),
    ),
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
export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  // Optional because not every provider needs every key.
  CODEX_OAUTH_CREDS_PATH: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Required: powers the `web_search` tool. Search and page-fetch both go
  // through Exa — without this key the tool throws on every call. Treated
  // as load-bearing rather than optional so startup fails fast if missing.
  EXA_API_KEY: z.string().min(1),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseConfig(value: unknown, source = "config"): Config {
  const parsed = ConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${source}:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

export function parseEnv(value: unknown, source = ".env"): Env {
  const parsed = EnvSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid env (check ${source}):\n${parsed.error.toString()}`);
  }
  return parsed.data;
}
