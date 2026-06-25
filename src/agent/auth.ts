// Provider auth resolution.
//
// Codex (the planned primary provider) authenticates via OAuth, not an API
// key. pi-ai handles the protocol; we own the credential file lifecycle:
//
//   1. Initial login (manual): use `pi-ai`'s CLI from a machine with a
//      browser, copy the resulting credentials JSON to `CODEX_OAUTH_CREDS_PATH`.
//   2. Per-call: read the file, refresh if the token is close to expiry,
//      persist the new creds back, hand the access token to the agent.
//
// The token typically lives ~1 hour; the refresh token is long-lived and
// only requires a browser dance again on revoke. See DESIGN.md §15 Phase 0
// for the empirical validation that confirmed this works on a long-lived Linux host.
//
// The Anthropic path is straightforward — just hand back the env-stored API key.

import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openaiCodexOAuthProvider, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { env } from "../config.js";
import { log } from "../lib/logger.js";
import { paths } from "../paths.js";

// Resolve the creds path: env override wins, otherwise default to the data
// dir. The default keeps secrets co-located with the rest of `~/.jarvis/`,
// which is already chmod-tightened and backed up alongside everything else.
function credsPath(): string {
  return env.CODEX_OAUTH_CREDS_PATH ?? join(paths.data, ".codex-creds.json");
}

// Refresh this many ms before the stored expiry. 5 min covers clock skew and
// any in-flight requests that could otherwise straddle expiry.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// In-memory cache of the most recent creds. The agent's `getApiKey` callback
// is invoked once per LLM request, so without caching we'd hit the disk every
// turn — fine, but pointlessly chatty.
let cached: OAuthCredentials | undefined;

async function loadCreds(): Promise<OAuthCredentials> {
  const path = credsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    // If the env override was set, surface the underlying error verbatim —
    // the user pointed us at a specific file and it's missing/unreadable.
    // Only swap in a friendlier message when we fell back to the default.
    if (!env.CODEX_OAUTH_CREDS_PATH) {
      throw new Error(
        `Codex OAuth credentials not found at default location ${path}. ` +
          `Run pi-ai's login flow on a machine with a browser, copy the ` +
          `resulting JSON to that path (chmod 600), or set ` +
          `CODEX_OAUTH_CREDS_PATH in .env to point at an existing creds file.`,
      );
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as OAuthCredentials;
  // Light-touch validation: pi-ai's refreshToken needs all three fields.
  if (!parsed.access || !parsed.refresh || typeof parsed.expires !== "number") {
    throw new Error(`malformed creds at ${path}`);
  }
  return parsed;
}

async function persistCreds(creds: OAuthCredentials): Promise<void> {
  const path = credsPath();
  await writeFile(path, JSON.stringify(creds, null, 2), "utf-8");
  // Re-tighten perms after every write — the file holds a refresh token.
  await chmod(path, 0o600);
}

// Returns a usable access token, refreshing if we're inside the buffer window.
// Safe to call on every request — refresh only fires when actually needed.
export async function getCodexAccessToken(): Promise<string> {
  if (!cached) cached = await loadCreds();

  if (cached.expires < Date.now() + REFRESH_BUFFER_MS) {
    log.info("refreshing codex oauth token");
    cached = await openaiCodexOAuthProvider.refreshToken(cached);
    await persistCreds(cached);
  }

  return openaiCodexOAuthProvider.getApiKey(cached);
}

// Called by the Agent before each LLM request. The provider name comes from
// `model.provider` in pi-ai's registry — see runtime.ts for the mapping
// from our config string ("codex" / "anthropic") to the provider key.
export async function getApiKeyForProvider(providerName: string): Promise<string | undefined> {
  if (providerName === "openai-codex") return getCodexAccessToken();
  if (providerName === "anthropic") return env.ANTHROPIC_API_KEY;
  if (providerName === "openrouter") return env.OPENROUTER_API_KEY;
  return undefined;
}
