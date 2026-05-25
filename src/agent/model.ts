import { getModel, type Model, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { config } from "../config.js";

// Register pi-ai's built-in providers (anthropic, openai-codex, etc.) so
// `getModel(provider, id)` can find them. Safe to do once at module load.
registerBuiltInApiProviders();

// Maps the friendly config string to pi-ai's provider key. The auth module
// keys off the same provider strings — keep these in sync.
const PROVIDER_KEY: Record<string, string> = {
  codex: "openai-codex",
  anthropic: "anthropic",
};

// Resolve the model once at startup. The same Model<> object is reused
// across every per-chat Agent we build — sessions only differ in transcript.
function resolveModel(): Model<any> {
  const providerKey = PROVIDER_KEY[config.agent.provider];
  if (!providerKey) {
    throw new Error(`unknown agent.provider: ${config.agent.provider}`);
  }
  const m = getModel(providerKey as any, config.agent.model as any);
  if (!m) {
    throw new Error(
      `model "${config.agent.model}" not found in provider "${providerKey}"`,
    );
  }
  return m;
}

export const model = resolveModel();
