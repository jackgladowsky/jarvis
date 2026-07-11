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
import { paths } from "./paths.js";
import { parseConfig, parseEnv, type Config, type Env } from "./config-schema.js";

export type { Config, Env } from "./config-schema.js";
export {
  CURRENT_CONFIG_SCHEMA_VERSION,
  ConfigSchema,
  EnvSchema,
  migrateConfig,
  parseConfig,
  parseEnv,
} from "./config-schema.js";

function loadConfig(): Config {
  return parseConfig(parseYaml(readFileSync(paths.configYaml, "utf-8")), paths.configYaml);
}

function loadEnv(): Env {
  return parseEnv(process.env, paths.env);
}

// Frozen at module load. Anything that imports `config` or `env` gets a
// snapshot. To change a value, edit the file and restart.
export const config: Readonly<Config> = Object.freeze(loadConfig());
export const env: Readonly<Env> = Object.freeze(loadEnv());
