// Model resolution.
//
// pi-ai ships registry entries for hundreds of models across dozens of
// providers (openai-codex, anthropic, openrouter, …). We register the
// built-in streaming providers, map our config-level provider names to
// pi-ai's keys, and resolve the Model<> object.
//
// Unlike most module-level singletons in this codebase, **model is live** —
// it can be swapped at runtime via switchModel() (e.g. from the /model
// command). All importers see the new value immediately because ES module
// `export let` creates a live binding.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModel, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

// Register pi-ai's built-in providers (anthropic, openai-codex, etc.) so
// `getModel(provider, id)` can find them. Safe to do once at module load.
registerBuiltInApiProviders();

// Maps the friendly config string to pi-ai's provider key. The auth module
// keys off the same provider strings — keep these in sync.
const PROVIDER_KEY: Record<string, string> = {
  codex: "openai-codex",
  anthropic: "anthropic",
  openrouter: "openrouter",
};

// Persisted runtime choice (set by /model) so the selection survives restarts.
const RUNTIME_MODEL_PATH = join(paths.data, "runtime-model.json");

interface RuntimeModelConfig {
  provider: string;
  modelId: string;
}

function loadRuntimeModel(): RuntimeModelConfig | null {
  try {
    if (existsSync(RUNTIME_MODEL_PATH)) {
      return JSON.parse(readFileSync(RUNTIME_MODEL_PATH, "utf-8"));
    }
  } catch {
    /* corrupt / missing — fall through */
  }
  return null;
}

function saveRuntimeModel(provider: string, modelId: string): void {
  try {
    mkdirSync(paths.data, { recursive: true });
    writeFileSync(RUNTIME_MODEL_PATH, JSON.stringify({ provider, modelId }, null, 2));
  } catch (err) {
    log.warn("failed to persist runtime model", { err: String(err) });
  }
}

// Resolve a Model object for the given provider and model-id.
//
// For openrouter we build a dynamic model because users can pass arbitrary
// model slugs (openai/gpt-4o, anthropic/claude-sonnet-4, …) that aren't
// all pre-registered in pi-ai's generated model table.
function resolveModel(provider: string, modelId: string): Model<any> {
  const providerKey = PROVIDER_KEY[provider];
  if (!providerKey) {
    throw new Error(`unknown agent.provider: ${provider}. Supported: ${Object.keys(PROVIDER_KEY).join(", ")}`);
  }

  if (provider === "openrouter") {
    // OpenRouter models are all OpenAI-compatible chat completions.
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 4_096,
    } as Model<any>;
  }

  const m = getModel(providerKey as any, modelId as any);
  if (!m) {
    throw new Error(`model "${modelId}" not found in provider "${providerKey}"`);
  }
  return m;
}

// Prefer the runtime-persisted choice (set via /model), fall back to config.yaml.
const runtime = loadRuntimeModel();
const initialProvider = runtime?.provider ?? config.agent.provider;
const initialModelId = runtime?.modelId ?? config.agent.model;

/** The currently active model. Reassignable at runtime via switchModel(). */
export let model: Model<any> = resolveModel(initialProvider, initialModelId);

/** List the provider keys the user can pass to /model. */
export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_KEY);
}

/**
 * Switch the active model at runtime.
 *
 * All code that imported the `model` binding will see the new value
 * immediately because ES module `export let` creates a live binding.
 *
 * @param persist - when true (default), saves the choice to disk so it
 *   survives a restart.
 */
export function switchModel(provider: string, modelId: string, persist = true): Model<any> {
  if (!PROVIDER_KEY[provider]) {
    throw new Error(
      `unknown provider: "${provider}". Supported: ${Object.keys(PROVIDER_KEY).join(", ")}`,
    );
  }
  const next = resolveModel(provider, modelId);
  model = next;
  log.info("switched model", { provider, modelId });
  if (persist) saveRuntimeModel(provider, modelId);
  return model;
}

/** Human-readable summary of the active model. */
export function describeModel(): string {
  return `${model.provider}/${model.id}`;
}