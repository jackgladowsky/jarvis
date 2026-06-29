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
// 1M+ context windows these models actually support. The fetch is async and
// cached in-memory; initial resolution uses a safe fallback (200K) until
// the API responds.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getModel, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

// ─── OpenRouter model context cache ───────────────────────────────────────
//
// Model metadata fetched from OpenRouter's public models endpoint. Populated
// on first OpenRouter resolution and refreshed on /model switches. The
// public endpoint works without an API key.

interface OpenRouterModelMeta {
  contextLength: number;
  maxCompletionTokens: number | null;
}

let orModelCache: Map<string, OpenRouterModelMeta> | null = null;
let orCachePromise: Promise<Map<string, OpenRouterModelMeta>> | null = null;

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
    for (const m of body.data ?? []) {
      cache.set(m.id, {
        contextLength: m.context_length ?? 200_000,
        maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
      });
    }
    log.info("fetched OpenRouter model metadata", { count: cache.size });
  } catch (err) {
    log.warn("failed to fetch OpenRouter models, using defaults", { err: String(err) });
  }
  return cache;
}

// Kick off the fetch if it hasn't started yet. Returns synchronously if
// cache is already populated; otherwise returns undefined (caller uses a
// safe default and can await the promise to update later).
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
    // Use the live cache if available; fall back to 200K before the first
    // API fetch completes. refreshModelContext() patches the binding once
    // the real data arrives.
    const fallbackCtx = 200_000;
    const fallbackMax = 4_096;
    const cached = ensureOrCache()?.get(modelId);
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cached?.contextLength ?? fallbackCtx,
      maxTokens: cached?.maxCompletionTokens ?? fallbackMax,
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

// Kick off the OpenRouter model cache fetch in the background. Once it
// resolves, patch the live model binding with the real context window.
// This runs before main() awaits anything meaningful, so the cache is
// usually populated by the time the first agent run starts.
ensureOrCache();
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
 * @param persist - when true (default), saves the choice to disk so it
 *   survives a restart.
 */
export function switchModel(provider: string, modelId: string, persist = true): Model<any> {
  if (!PROVIDER_KEY[provider]) {
    throw new Error(`unknown provider: "${provider}". Supported: ${Object.keys(PROVIDER_KEY).join(", ")}`);
  }
  const next = resolveModel(provider, modelId);
  model = next;
  log.info("switched model", { provider, modelId });
  if (persist) saveRuntimeModel(provider, modelId);
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
