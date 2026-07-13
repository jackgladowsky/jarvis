import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "../lib/durable-file.js";
import { paths } from "../paths.js";

const KERNEL_API = "https://api.onkernel.com";
const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,255}$/;
const SAFE_DOMAIN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;
const USER_COMPLETED_AUTH_SETTINGS = {
  health_checks: false,
  auto_reauth: false,
  save_credentials: false,
  record_session: false,
} as const;

export interface KernelSettings {
  apiKeyEnv: string;
  profileName: string;
  saveChanges: boolean;
}

export interface KernelBrowserSession {
  sessionId: string;
  cdpWsUrl: string;
}

export interface KernelAuthStatus {
  id: string;
  domain: string;
  profileName: string;
  status: string;
  flowStatus: string | null;
  flowStep: string | null;
  flowExpiresAt: string | null;
  updatedAt: string;
}

interface KernelResponse {
  [key: string]: unknown;
}

function apiKey(settings: KernelSettings): string {
  const name = settings.apiKeyEnv.slice(1);
  const value = process.env[name];
  if (!value) throw new Error(`Kernel backend is unavailable: environment reference ${settings.apiKeyEnv} is unset.`);
  return value;
}

function safeError(response: Response): Error {
  // Kernel errors can echo URLs or flow context. Never surface their body.
  return new Error(`Kernel request failed (${response.status}).`);
}

async function request(settings: KernelSettings, path: string, init: RequestInit = {}): Promise<KernelResponse> {
  const response = await fetch(`${KERNEL_API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiKey(settings)}`, "content-type": "application/json", ...init.headers },
    signal: init.signal,
  });
  if (!response.ok) throw safeError(response);
  return (await response.json()) as KernelResponse;
}

export async function createKernelBrowser(
  settings: KernelSettings,
  signal?: AbortSignal,
): Promise<KernelBrowserSession> {
  const data = await request(settings, "/browsers", {
    method: "POST",
    body: JSON.stringify({
      headless: true,
      stealth: true,
      timeout_seconds: 120,
      profile: { name: settings.profileName, save_changes: settings.saveChanges },
    }),
    signal,
  });
  if (typeof data.session_id !== "string" || typeof data.cdp_ws_url !== "string") {
    throw new Error("Kernel returned an invalid browser session.");
  }
  return { sessionId: data.session_id, cdpWsUrl: data.cdp_ws_url };
}

export async function deleteKernelBrowser(settings: KernelSettings, sessionId: string): Promise<void> {
  if (!sessionId) return;
  await request(settings, `/browsers/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

function assertAuthInput(domain: string, profileName: string): void {
  if (!SAFE_DOMAIN.test(domain)) throw new Error("Kernel auth requires a public domain name.");
  if (!SAFE_PROFILE.test(profileName)) throw new Error("Kernel auth profile name is invalid.");
}

function safeStatus(data: KernelResponse): KernelAuthStatus {
  if (typeof data.id !== "string" || typeof data.domain !== "string" || typeof data.profile_name !== "string") {
    throw new Error("Kernel returned an invalid auth status.");
  }
  return {
    id: data.id,
    domain: data.domain,
    profileName: data.profile_name,
    status: typeof data.status === "string" ? data.status : "UNKNOWN",
    flowStatus: typeof data.flow_status === "string" ? data.flow_status : null,
    flowStep: typeof data.flow_step === "string" ? data.flow_step : null,
    flowExpiresAt: typeof data.flow_expires_at === "string" ? data.flow_expires_at : null,
    updatedAt: new Date().toISOString(),
  };
}

const AUTH_STATE = join(paths.workbench, "kernel-auth.json");

async function persistAuth(status: KernelAuthStatus): Promise<void> {
  await mkdir(paths.workbench, { recursive: true, mode: 0o700 });
  let records: KernelAuthStatus[] = [];
  try {
    const parsed = JSON.parse(await readFile(AUTH_STATE, "utf-8")) as unknown;
    if (Array.isArray(parsed))
      records = parsed.filter((item): item is KernelAuthStatus => typeof item === "object" && item !== null);
  } catch {
    // Missing/corrupt cache is non-authoritative; overwrite with the current safe record.
  }
  const next = [...records.filter((record) => record.id !== status.id), status].slice(-100);
  await atomicWriteJson(AUTH_STATE, next, { mode: 0o600 });
}

export async function startKernelAuth(
  settings: KernelSettings,
  input: { domain: string; profileName: string },
): Promise<{ hostedUrl: string; expiresAt: string | null; status: KernelAuthStatus }> {
  assertAuthInput(input.domain, input.profileName);
  let connection: KernelResponse;
  try {
    connection = await request(settings, "/auth/connections", {
      method: "POST",
      // Keep this strictly user-completed: no credential retention, recording, health checks, or reauth.
      body: JSON.stringify({ domain: input.domain, profile_name: input.profileName, ...USER_COMPLETED_AUTH_SETTINGS }),
    });
  } catch (err) {
    // A duplicate resource is safe to reuse only through an explicit exact domain/profile lookup.
    const listed = await request(
      settings,
      `/auth/connections?domain=${encodeURIComponent(input.domain)}&profile_name=${encodeURIComponent(input.profileName)}`,
    );
    const found = Array.isArray(listed.data)
      ? listed.data.find(
          (item): item is KernelResponse =>
            typeof item === "object" &&
            item !== null &&
            (item as KernelResponse).domain === input.domain &&
            (item as KernelResponse).profile_name === input.profileName,
        )
      : undefined;
    if (!found) throw err;
    connection = found;
  }
  if (typeof connection.id !== "string") throw new Error("Kernel returned an invalid auth connection.");
  // Reused connections may predate JARVIS and have credential/reauth defaults enabled.
  // Force the same user-completed-only policy before a new login flow begins.
  await request(settings, `/auth/connections/${encodeURIComponent(connection.id)}`, {
    method: "PATCH",
    body: JSON.stringify(USER_COMPLETED_AUTH_SETTINGS),
  });
  const login = await request(settings, `/auth/connections/${encodeURIComponent(connection.id)}/login`, {
    method: "POST",
    body: "{}",
  });
  if (typeof login.hosted_url !== "string") throw new Error("Kernel did not return a hosted login URL.");
  const status = safeStatus(await request(settings, `/auth/connections/${encodeURIComponent(connection.id)}`));
  await persistAuth(status);
  return {
    hostedUrl: login.hosted_url,
    expiresAt: typeof login.flow_expires_at === "string" ? login.flow_expires_at : null,
    status,
  };
}

export async function getKernelAuthStatus(settings: KernelSettings, connectionId: string): Promise<KernelAuthStatus> {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(connectionId)) throw new Error("Kernel auth connection id is invalid.");
  const status = safeStatus(await request(settings, `/auth/connections/${encodeURIComponent(connectionId)}`));
  await persistAuth(status);
  return status;
}
