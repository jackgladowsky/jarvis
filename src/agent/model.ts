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
//
// For OpenRouter models, contextWindow is fetched live from the models API
// instead of hardcoding a conservative default — otherwise we'd waste the
// 1M+ context windows these models actually support. The cache is persisted
// to disk so correct context windows are available immediately on restart
// with no 200K fallback window.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModel, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { parseDocument } from "yaml";
import { config, parseConfig } from "../config.js";
import { atomicWriteFileSync, atomicWriteJsonSync } from "../lib/durable-file.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

// ─── OpenRouter model context cache ───────────────────────────────────────
//
// Model metadata fetched from OpenRouter's public models endpoint. Populated
// on first OpenRouter resolution and refreshed on /model switches. The
// public endpoint works without an API key.
//
// Persisted to disk so we never need a conservative fallback — after the
// first ever API fetch, every restart reads the real context windows from
// a local JSON file immediately.

interface OpenRouterModelMeta {
  contextLength: number;
  maxCompletionTokens: number | null;
}

const OR_CACHE_PATH = join(paths.data, "openrouter-models-cache.json");

let orModelCache: Map<string, OpenRouterModelMeta> | null = null;
let orCachePromise: Promise<Map<string, OpenRouterModelMeta>> | null = null;

/** Load the disk cache synchronously at module init. Returns null if absent/corrupt. */
function loadOrCacheFromDisk(): Map<string, OpenRouterModelMeta> | null {
  try {
    if (existsSync(OR_CACHE_PATH)) {
      const raw = readFileSync(OR_CACHE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Array<{
        id: string;
        contextLength: number;
        maxCompletionTokens: number | null;
      }>;
      const map = new Map<string, OpenRouterModelMeta>();
      for (const entry of parsed) {
        map.set(entry.id, {
          contextLength: entry.contextLength,
          maxCompletionTokens: entry.maxCompletionTokens,
        });
      }
      if (map.size > 0) {
        log.info("loaded OpenRouter model metadata from disk cache", { count: map.size });
        return map;
      }
    }
  } catch (err) {
    log.warn("failed to load OpenRouter disk cache", { err: String(err) });
  }
  return null;
}

/** Write the in-memory cache to disk so the next restart is fast. */
function persistOrCacheToDisk(cache: Map<string, OpenRouterModelMeta>): void {
  try {
    mkdirSync(paths.data, { recursive: true });
    const data = Array.from(cache.entries()).map(([id, meta]) => ({
      id,
      contextLength: meta.contextLength,
      maxCompletionTokens: meta.maxCompletionTokens,
    }));
    atomicWriteFileSync(OR_CACHE_PATH, JSON.stringify(data));
  } catch (err) {
    log.warn("failed to persist OpenRouter model cache", { err: String(err) });
  }
}

async function fetchOpenRouterModels(): Promise<Map<string, OpenRouterModelMeta>> {
  const cache = new Map<string, OpenRouterModelMeta>();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`OpenRouter models API returned ${res.status}`);
    const body = (await res.json()) as {
      data: Array<{ id: string; context_length?: number; top_provider?: { max_completion_tokens?: number } }>;
    };
    let missingCtxCount = 0;
    for (const m of body.data ?? []) {
      if (m.context_length == null) missingCtxCount++;
      cache.set(m.id, {
        // If the API didn't return a context_length (extremely rare), use a
        // safe floor of 128K and log a warning.
        contextLength: m.context_length ?? 128_000,
        maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
      });
    }
    if (missingCtxCount > 0) {
      log.warn(`${missingCtxCount} OpenRouter models missing context_length, used 128K fallback`);
    }
    log.info("fetched OpenRouter model metadata", { count: cache.size });

    // Persist to disk so subsequent restarts have immediate access.
    persistOrCacheToDisk(cache);
  } catch (err) {
    log.warn("failed to fetch OpenRouter models, keeping disk cache", { err: String(err) });
  }
  return cache;
}

// Kick off the fetch if it hasn't started yet. Returns synchronously if
// cache is already populated (from disk or previous API fetch); otherwise
// returns undefined (caller falls through to a safe default).
function ensureOrCache(): Map<string, OpenRouterModelMeta> | undefined {
  if (orModelCache) return orModelCache;
  if (!orCachePromise) {
    orCachePromise = fetchOpenRouterModels().then((c) => {
      orModelCache = c;
      return c;
    });
  }
  return undefined; // not ready yet
}

// Await the cache and update the live model binding if the resolved context
// differs from the initial fallback. Called at startup and after /model.
async function refreshModelContext(modelToRefresh: Model<any>): Promise<void> {
  if (modelToRefresh.provider !== "openrouter") return;
  const cache = orCachePromise ? await orCachePromise : orModelCache;
  if (!cache) return;
  const meta = cache.get(modelToRefresh.id);
  if (!meta) return;
  if (meta.contextLength === modelToRefresh.contextWindow) return; // already correct

  log.info("updating OpenRouter model context window", {
    modelId: modelToRefresh.id,
    from: modelToRefresh.contextWindow,
    to: meta.contextLength,
  });
  (modelToRefresh as unknown as Record<string, unknown>).contextWindow = meta.contextLength;
  if (meta.maxCompletionTokens) {
    (modelToRefresh as unknown as Record<string, unknown>).maxTokens = meta.maxCompletionTokens;
  }
}

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

const CUSTOM_CODEX_MODELS: Record<
  string,
  {
    name: string;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }
> = {
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
  },
};

function resolveCustomCodexModel(modelId: string): Model<any> | undefined {
  const custom = CUSTOM_CODEX_MODELS[modelId];
  if (!custom) return undefined;
  return {
    id: modelId,
    name: custom.name,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
    input: ["text", "image"],
    cost: custom.cost,
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  } as Model<any>;
}

// Persisted runtime choice (set by /model) so the selection survives restarts.
const RUNTIME_MODEL_PATH = paths.runtimeModel;

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
  mkdirSync(paths.data, { recursive: true });
  atomicWriteJsonSync(RUNTIME_MODEL_PATH, { provider, modelId });
}

/**
 * Persist the configured default selected by `/model` without reformatting or
 * dropping unrelated YAML/comments. `config` is intentionally frozen, so this
 * updates the source of truth for the next process rather than mutating it.
 */
function saveConfiguredModel(provider: string, modelId: string): void {
  const source = readFileSync(paths.configYaml, "utf-8");
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new Error(`Unable to parse config at ${paths.configYaml}: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }

  // Validate both the on-disk document and the edited result. This prevents a
  // switch from overwriting a config that was changed into an invalid state by
  // another process after startup.
  parseConfig(document.toJS(), paths.configYaml);
  document.setIn(["agent", "provider"], provider);
  document.setIn(["agent", "model"], modelId);
  parseConfig(document.toJS(), paths.configYaml);

  atomicWriteFileSync(paths.configYaml, document.toString());
}

// Resolve a Model object for the given provider and model-id.
//
// For openrouter we build a dynamic model because users can pass arbitrary
// model slugs (openai/gpt-4o, anthropic/claude-sonnet-4, …) that aren't
// all pre-registered in pi-ai's generated model table.
export function resolveModel(provider: string, modelId: string): Model<any> {
  const providerKey = PROVIDER_KEY[provider];
  if (!providerKey) {
    throw new Error(`unknown agent.provider: ${provider}. Supported: ${Object.keys(PROVIDER_KEY).join(", ")}`);
  }

  if (provider === "openrouter") {
    // OpenRouter models are all OpenAI-compatible chat completions.
    //
    // Use the cache if available. On first ever run (no disk cache, no API
    // response yet), use a safe 128K floor — but this window is tiny because
    // the disk load runs synchronously at module init, and the API fetch
    // resolves within a few seconds.
    const fallbackCtx = 128_000;
    const fallbackMax = 4_096;
    const cached = ensureOrCache()?.get(modelId);
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cached?.contextLength ?? fallbackCtx,
      maxTokens: cached?.maxCompletionTokens ?? fallbackMax,
      headers: {
        "HTTP-Referer": "https://github.com/jackgladowsky/jarvis",
        "X-OpenRouter-Title": "JARVIS",
      },
    } as Model<any>;
  }

  const customCodexModel = provider === "codex" ? resolveCustomCodexModel(modelId) : undefined;
  if (customCodexModel) return customCodexModel;

  const m = getModel(providerKey as any, modelId as any);
  if (!m) {
    throw new Error(`model "${modelId}" not found in provider "${providerKey}"`);
  }
  return m;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────

// Try to load disk cache immediately so OpenRouter models have correct
// context windows from module init — no 200K fallback window.
const diskCache = loadOrCacheFromDisk();
if (diskCache) {
  orModelCache = diskCache;
}

// Prefer the runtime-persisted choice (set via /model), fall back to config.yaml.
const runtime = loadRuntimeModel();

/** The currently active model. Reassignable at runtime via switchModel(). */
export let model: Model<any> = (() => {
  if (runtime) {
    try {
      return resolveModel(runtime.provider, runtime.modelId);
    } catch (err) {
      // Host-local runtime state is a preference, not a reason to take the
      // entire bot offline after a model is removed/renamed.
      log.warn("persisted runtime model is invalid; using config.yaml", {
        provider: runtime.provider,
        modelId: runtime.modelId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return resolveModel(config.agent.provider, config.agent.model);
})();

// Fetch OpenRouter metadata only when OpenRouter is actually active. The old
// unconditional startup fetch delayed/offlined Codex- and Anthropic-only
// installs (and their tests) for data they never used. Resolving an OpenRouter
// fallback or switching providers still calls ensureOrCache on demand.
if (!diskCache && model.provider === "openrouter") ensureOrCache();
if (model.provider === "openrouter") {
  refreshModelContext(model).catch((err) => log.warn("background model context refresh failed", { err: String(err) }));
}

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
 * @param persist - when true (default), saves the choice to the configured
 *   default and runtime state so it survives a restart. Temporary switches
 *   leave both persisted values unchanged.
 */
export function switchModel(provider: string, modelId: string, persist = true): Model<any> {
  if (!PROVIDER_KEY[provider]) {
    throw new Error(`unknown provider: "${provider}". Supported: ${Object.keys(PROVIDER_KEY).join(", ")}`);
  }
  const next = resolveModel(provider, modelId);

  // Persist before changing the live binding: a failed durable write must not
  // report a runtime switch that disappears on restart. Each destination is
  // atomically replaced by durable-file, preserving the existing runtime
  // override alongside the configured default.
  if (persist) {
    saveConfiguredModel(provider, modelId);
    saveRuntimeModel(provider, modelId);
  }

  model = next;
  log.info("switched model", { provider, modelId });
  // Kick off a context window refresh from OpenRouter if applicable.
  // The model binding is live, so once the cache resolves the updated
  // contextWindow and maxTokens are available immediately on the same object.
  if (provider === "openrouter") {
    ensureOrCache();
    refreshModelContext(next).catch((err) =>
      log.warn("model context refresh after switch failed", { err: String(err) }),
    );
  }
  return model;
}

/** Human-readable summary of the active model. */
export function describeModel(): string {
  return `${model.provider}/${model.id}`;
}
