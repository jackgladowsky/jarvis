import { z } from "zod";

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const ProviderModelOverrideSchema = z
  .object({
    provider: z.enum(["codex", "anthropic", "openrouter"]).optional(),
    model: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.provider) === Boolean(value.model)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provider and model must be configured together",
    });
  });

const ModelSelectionSchema = z
  .object({
    provider: z.enum(["codex", "anthropic", "openrouter"]),
    model: z.string().min(1),
  })
  .strict();

export const CURRENT_CONFIG_SCHEMA_VERSION = 3 as const;

// Schema mirrors config.yaml.example exactly. Any drift between the example
// and this schema is a bug — the example is documentation, this is enforcement.
export const ConfigSchema = z
  .object({
    schema_version: z.literal(CURRENT_CONFIG_SCHEMA_VERSION),
    agent: z
      .object({
        provider: z.enum(["codex", "anthropic", "openrouter"]),
        model: z.string().min(1),
      })
      .strict(),
    session: z
      .object({
        inactivity_threshold_minutes: z.number().int().positive(),
        max_duration_hours: z.number().positive(),
        summarize_on_rotation: z.boolean(),
        announce_new_session: z.boolean(),
      })
      .strict(),
    // Compaction settings mirror pi-coding-agent's defaults. See DESIGN.md §10.
    compaction: z
      .object({
        enabled: z.boolean(),
        reserve_tokens: z.number().int().positive(),
        keep_recent_tokens: z.number().int().positive(),
      })
      .strict(),
    tools: z
      .object({
        bash: z
          .object({
            default_timeout_seconds: z.number().int().positive(),
            max_timeout_seconds: z.number().int().positive(),
          })
          .strict()
          .refine((value) => value.default_timeout_seconds <= value.max_timeout_seconds, {
            message: "default_timeout_seconds must be <= max_timeout_seconds",
            path: ["default_timeout_seconds"],
          }),
        owner_approval: z
          .object({
            // false is Jack's explicit current-host default. Set true to restore
            // exact-plan Telegram confirmations for normal privileged actions.
            required: z.boolean(),
          })
          .strict(),
        browser: z
          .object({
            backend: z.enum(["local", "kernel"]),
            kernel: z
              .object({
                api_key_env: z
                  .string()
                  .regex(/^\$[A-Z][A-Z0-9_]*$/, "must be an env-var reference such as $KERNEL_API_KEY"),
                profile_name: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
                save_changes: z.boolean(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    background: z
      .object({
        max_concurrent_workers: z.number().int().positive().max(16),
        role_models: z
          .object({
            planner: ModelSelectionSchema.optional(),
            researcher: ModelSelectionSchema.optional(),
            implementer: ModelSelectionSchema.optional(),
            reviewer: ModelSelectionSchema.optional(),
            fixer: ModelSelectionSchema.optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    telegram: z
      .object({
        show_typing: z.boolean(),
        long_tool_call_seconds: z.number().int().positive(),
        parse_mode: z.enum(["none", "MarkdownV2", "HTML"]),
        model_favorites: z
          .array(
            z
              .object({
                label: z.string(),
                provider: z.enum(["codex", "anthropic", "openrouter"]),
                model_id: z.string(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    stt: z
      .object({
        provider: z.enum(["disabled", "local-whisper-cpp"]),
        local_whisper_cpp: z
          .object({
            whisper_binary_path: z.string().min(1),
            model_path: z.string().min(1),
            ffmpeg_path: z.string().min(1).nullable(),
            max_audio_mb: z.number().int().positive(),
            timeout_seconds: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
    scheduler: z
      .object({
        enabled: z.boolean(),
        timezone: z.string().min(1).refine(isIanaTimezone, "timezone must be a valid IANA timezone"),
        telegram_chat_id: z.number().int(),
        tasks: z.array(
          ProviderModelOverrideSchema.and(
            z.object({
              id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
              name: z.string().min(1),
              schedule: z.string().min(1),
              prompt: z.string().min(1),
              notify: z.enum(["always", "on_issue", "never"]),
            }),
          ),
        ),
      })
      .strict(),
    logging: z
      .object({
        audit_log_enabled: z.boolean(),
        audit_log_max_value_bytes: z.number().int().positive(),
        audit_log_redact_patterns: z.boolean(),
        level: z.enum(["debug", "info", "warn", "error"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scheduler.enabled && value.scheduler.telegram_chat_id === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scheduler", "telegram_chat_id"],
        message: "telegram_chat_id must be non-zero when the scheduler is enabled",
      });
    }
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

export function migrateConfig(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const version = input.schema_version;
  const defaultBrowser = {
    backend: "local",
    kernel: { api_key_env: "$KERNEL_API_KEY", profile_name: "jarvis", save_changes: false },
  };
  const defaultOwnerApproval = { required: false };
  if (version === undefined || version === 1 || version === 2) {
    // v0/v1 predate browser backend selection; v0-v2 predate the explicit
    // owner-approval policy. Preserve local browsing and Jack's approval-free default.
    const tools =
      typeof input.tools === "object" && input.tools !== null ? (input.tools as Record<string, unknown>) : input.tools;
    return {
      ...input,
      schema_version: CURRENT_CONFIG_SCHEMA_VERSION,
      tools:
        typeof tools === "object" && tools !== null
          ? {
              ...(tools as Record<string, unknown>),
              browser: (tools as Record<string, unknown>).browser ?? defaultBrowser,
              owner_approval: (tools as Record<string, unknown>).owner_approval ?? defaultOwnerApproval,
            }
          : tools,
    };
  }
  return value;
}

export function parseConfig(value: unknown, source = "config"): Config {
  const parsed = ConfigSchema.safeParse(migrateConfig(value));
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
