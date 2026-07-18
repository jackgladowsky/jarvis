import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadAudit() {
  const data = await mkdtemp(join(tmpdir(), "jarvis-lifecycle-audit-"));
  process.env.JARVIS_DATA_DIR = data;
  process.env.TELEGRAM_BOT_TOKEN = "test";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "1";
  process.env.EXA_API_KEY = "test";
  await mkdir(join(data, "prompts"), { recursive: true });
  await writeFile(join(data, "prompts", "system.md"), "test");
  await writeFile(
    join(data, "config.yaml"),
    [
      "agent: { provider: codex, model: gpt-5.1 }",
      "session: { inactivity_threshold_minutes: 60, max_duration_hours: 24, summarize_on_rotation: false, announce_new_session: false }",
      "compaction: { enabled: true, reserve_tokens: 2000, keep_recent_tokens: 100 }",
      "tools: { bash: { default_timeout_seconds: 30, max_timeout_seconds: 60 } }",
      "telegram: { show_typing: false, long_tool_call_seconds: 5, parse_mode: none }",
      "stt: { provider: disabled, local_whisper_cpp: { whisper_binary_path: /tmp/w, model_path: /tmp/m, ffmpeg_path: null, max_audio_mb: 1, timeout_seconds: 1 } }",
      "scheduler: { enabled: false, timezone: UTC, telegram_chat_id: 0, tasks: [] }",
      "logging: { audit_log_enabled: true, audit_log_max_value_bytes: 256, audit_log_redact_patterns: true, level: info }",
    ].join("\n"),
  );
  return { data, audit: await import("./lifecycle-audit.js") };
}

test("lifecycle events retain correlation while redacting and bounding payloads", async () => {
  const { data, audit } = await loadAudit();
  const context = {
    run_id: "run-1",
    run_kind: "chat" as const,
    session_id: "session-1",
    turn_id: "turn-1",
    chat_id: 42,
  };
  await audit.withLifecycleContext(context, () =>
    audit.auditLifecycle("tool.execution", {
      outcome: "ok",
      tool_call_id: "call-1",
      data: {
        api_key: "sk-abcdefghijklmnopqrstuvwxyz123456",
        nested: { password: "never-log" },
        giant: "x".repeat(100_000),
      },
    }),
  );
  const raw = await readFile(join(data, "data", "lifecycle-audit.jsonl"), "utf-8");
  assert.ok(Buffer.byteLength(raw) < 20 * 1024);
  assert.doesNotMatch(raw, /abcdefghijklmnopqrstuvwxyz|never-log/);
  const event = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(event.run_id, "run-1");
  assert.equal(event.session_id, "session-1");
  assert.equal(event.turn_id, "turn-1");
  assert.equal(event.tool_call_id, "call-1");
  assert.equal(typeof event.event_id, "string");
});

test("cyclic and deeply nested descriptors are bounded before serialization", async () => {
  const { audit } = await loadAudit();
  const cyclic: Record<string, unknown> = { huge: "x".repeat(1_000_000) };
  cyclic.self = cyclic;
  let deep: Record<string, unknown> = cyclic;
  for (let index = 0; index < 100; index += 1) deep = { child: deep };
  const descriptor = audit.payloadDescriptor(deep);
  assert.equal(typeof descriptor.sha256, "string");
  assert.equal(descriptor.bounded, true);
  const ok = await audit.auditLifecycle("test.cyclic", { outcome: "ok", data: deep });
  assert.equal(ok, true);
});

test("lifecycle audit failure is surfaced without rejecting the caller", async () => {
  const { audit } = await loadAudit();
  const before = audit.lifecycleAuditFailureCount();
  const ok = await audit.auditLifecycle(
    "test.failure",
    { outcome: "ok" },
    {
      append: async () => {
        throw new Error("audit disk unavailable");
      },
    },
  );
  assert.equal(ok, false);
  assert.equal(audit.lifecycleAuditFailureCount(), before + 1);
  let terminal = "";
  await audit.auditLifecycle(
    "turn.finished",
    { outcome: "ok" },
    { append: async (_path, data) => void (terminal = data) },
  );
  assert.equal((JSON.parse(terminal) as { audit_degraded?: boolean }).audit_degraded, true);
});
