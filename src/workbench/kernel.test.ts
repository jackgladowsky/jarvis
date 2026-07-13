import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = join(tmpdir(), `jarvis-kernel-test-${process.pid}`);
process.env.JARVIS_DATA_DIR = dataDir;
process.env.TEST_KERNEL_KEY = "kernel-test-secret";

const { startKernelAuth } = await import("./kernel.js");
const { paths } = await import("../paths.js");

const settings = { apiKeyEnv: "$TEST_KERNEL_KEY", profileName: "jarvis", saveChanges: false };
const safeSettings = { health_checks: false, auto_reauth: false, save_credentials: false, record_session: false };
const authStatus = {
  id: "ma_safe",
  domain: "example.com",
  profile_name: "jarvis",
  status: "NEEDS_AUTH",
  flow_status: "IN_PROGRESS",
  flow_step: "AWAITING_INPUT",
  flow_expires_at: "2030-01-01T00:00:00Z",
  discovered_fields: [{ type: "password" }],
};

function installFetch(responses: Array<{ body: unknown; status?: number }>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected Kernel request");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = originalFetch) };
}

test("Kernel hosted auth persists only safe identifiers/status and disables all automatic auth", async () => {
  await rm(dataDir, { recursive: true, force: true });
  const { calls, restore } = installFetch([
    { body: { id: "ma_safe" } },
    { body: authStatus }, // PATCH safe policy
    {
      body: {
        hosted_url: "https://auth.kernel.example/login/one-time",
        flow_expires_at: "2030-01-01T00:00:00Z",
        handoff_code: "do-not-store",
      },
    },
    { body: authStatus },
  ]);
  try {
    const result = await startKernelAuth(settings, { domain: "example.com", profileName: "jarvis" });
    assert.equal(result.status.id, "ma_safe");
    assert.match(result.hostedUrl, /one-time/);
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), {
      domain: "example.com",
      profile_name: "jarvis",
      ...safeSettings,
    });
    assert.equal(calls[1]?.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[1]?.body ?? "{}"), safeSettings);
    const persisted = await readFile(join(paths.workbench, "kernel-auth.json"), "utf-8");
    assert.match(persisted, /ma_safe/);
    assert.doesNotMatch(persisted, /one-time|do-not-store|password|kernel-test-secret/i);
  } finally {
    restore();
  }
});

test("Kernel hosted auth hardens a reused connection before starting login", async () => {
  const { calls, restore } = installFetch([
    { status: 409, body: { code: "already_exists" } },
    { body: { data: [{ id: "ma_safe", domain: "example.com", profile_name: "jarvis" }] } },
    { body: authStatus }, // PATCH safe policy
    { body: { hosted_url: "https://auth.kernel.example/login/reused" } },
    { body: authStatus },
  ]);
  try {
    await startKernelAuth(settings, { domain: "example.com", profileName: "jarvis" });
    assert.match(calls[1]?.url ?? "", /domain=example.com/);
    assert.equal(calls[2]?.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[2]?.body ?? "{}"), safeSettings);
    assert.match(calls[3]?.url ?? "", /\/login$/);
  } finally {
    restore();
  }
});
