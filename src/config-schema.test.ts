import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { CURRENT_CONFIG_SCHEMA_VERSION, migrateConfig, parseConfig, parseEnv } from "./config-schema.js";

test("config example validates against the runtime schema", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const config = parseConfig(parseYaml(raw), "config.yaml.example");

  assert.equal(config.schema_version, CURRENT_CONFIG_SCHEMA_VERSION);
  assert.equal(config.agent.provider, "codex");
  assert.equal(config.telegram.parse_mode, "HTML");
  assert.deepEqual(config.scheduler.tasks, []);
});

test("unversioned config migrates losslessly to the current schema", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const legacy = parseYaml(raw) as Record<string, unknown>;
  delete legacy.schema_version;

  const migrated = migrateConfig(legacy) as Record<string, unknown>;
  assert.equal(migrated.schema_version, CURRENT_CONFIG_SCHEMA_VERSION);
  assert.equal(parseConfig(legacy).schema_version, CURRENT_CONFIG_SCHEMA_VERSION);
  assert.equal(legacy.schema_version, undefined);
});

test("future config versions fail closed", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const config = parseYaml(raw) as Record<string, unknown>;
  config.schema_version = CURRENT_CONFIG_SCHEMA_VERSION + 1;
  assert.throws(() => parseConfig(config, "future-config"), /schema_version/);
});

test("config parser accepts per-scheduled-task model overrides", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const config = parseYaml(raw) as any;
  config.scheduler.tasks = [
    {
      id: "voice-review",
      name: "Voice review",
      schedule: "45 3 * * *",
      prompt: "Review voice",
      notify: "on_issue",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    },
  ];

  assert.equal(parseConfig(config, "task-model").scheduler.tasks[0]?.model, "google/gemini-2.5-flash");
});

test("legacy config migrates to the local browser backend and Kernel references reject literals", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const legacy = parseYaml(raw) as any;
  legacy.schema_version = 1;
  delete legacy.tools.browser;
  assert.equal(parseConfig(legacy).tools.browser.backend, "local");

  const unsafe = parseYaml(raw) as any;
  unsafe.tools.browser.kernel.api_key_env = "actual-secret";
  assert.throws(() => parseConfig(unsafe), /env-var reference/);
});

test("config parser requires scheduled provider and model overrides together", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const config = parseYaml(raw) as any;
  config.scheduler.tasks = [
    {
      id: "broken-override",
      name: "Broken override",
      schedule: "0 1 * * *",
      prompt: "test",
      notify: "never",
      provider: "anthropic",
    },
  ];

  assert.throws(() => parseConfig(config), /provider and model must be configured together/);
});

test("config parser validates bash timeout ordering and scheduler timezone", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const timeoutConfig = parseYaml(raw) as any;
  timeoutConfig.tools.bash.default_timeout_seconds = 30;
  timeoutConfig.tools.bash.max_timeout_seconds = 10;
  assert.throws(() => parseConfig(timeoutConfig), /default_timeout_seconds/);

  const timezoneConfig = parseYaml(raw) as any;
  timezoneConfig.scheduler.timezone = "Mars/Olympus_Mons";
  assert.throws(() => parseConfig(timezoneConfig), /IANA timezone/);
});

test("config parser requires a notification chat when scheduler is enabled", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const config = parseYaml(raw) as any;
  config.scheduler.enabled = true;
  config.scheduler.telegram_chat_id = 0;
  assert.throws(() => parseConfig(config), /telegram_chat_id must be non-zero/);
});

test("config parser rejects missing required tunables", () => {
  assert.throws(
    () => parseConfig({ agent: { provider: "codex", model: "gpt" } }, "test-config"),
    /Invalid config at test-config/,
  );
});

test("config parser rejects invalid scheduler task ids", async () => {
  const raw = await readFile(new URL("../config.yaml.example", import.meta.url), "utf-8");
  const config = parseYaml(raw) as any;
  config.scheduler.tasks = [{ id: "not ok", name: "Bad", schedule: "* * * * *", prompt: "x", notify: "always" }];

  assert.throws(() => parseConfig(config, "bad-task"), /scheduler/);
});

test("env parser accepts only required secret-shaped values plus optional provider keys", () => {
  const env = parseEnv({
    TELEGRAM_BOT_TOKEN: "telegram-token",
    TELEGRAM_ALLOWED_USER_IDS: "123,456",
    EXA_API_KEY: "exa-key",
    ANTHROPIC_API_KEY: "anthropic-key",
  });

  assert.equal(env.TELEGRAM_ALLOWED_USER_IDS, "123,456");
  assert.equal(env.CODEX_OAUTH_CREDS_PATH, undefined);
});

test("env parser fails fast when load-bearing secrets are absent", () => {
  assert.throws(() => parseEnv({ TELEGRAM_BOT_TOKEN: "x" }), /TELEGRAM_ALLOWED_USER_IDS/);
});
