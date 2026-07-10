import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";

async function loadAuditWrapper() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-audited-tool-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test prompt", "utf-8");
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      "agent: { provider: codex, model: gpt-5.1 }",
      "session: { inactivity_threshold_minutes: 60, max_duration_hours: 24, summarize_on_rotation: false, announce_new_session: false }",
      "compaction: { enabled: false, reserve_tokens: 1000, keep_recent_tokens: 100 }",
      "tools:",
      "  bash: { default_timeout_seconds: 30, max_timeout_seconds: 120 }",
      "telegram: { show_typing: false, long_tool_call_seconds: 5, parse_mode: none }",
      "stt:",
      "  provider: disabled",
      "  local_whisper_cpp: { whisper_binary_path: /tmp/whisper-cli, model_path: /tmp/model, ffmpeg_path: /usr/bin/ffmpeg, max_audio_mb: 25, timeout_seconds: 120 }",
      "scheduler: { enabled: false, timezone: UTC, telegram_chat_id: 0, tasks: [] }",
      "logging: { audit_log_enabled: false, audit_log_max_value_bytes: 2048, audit_log_redact_patterns: true, level: info }",
      "",
    ].join("\n"),
    "utf-8",
  );
  return { dataDir, audited: await import("./audited.js") };
}

test("audit wrapper records success, encoded errors, and thrown errors without changing outcomes", async () => {
  const { dataDir, audited } = await loadAuditWrapper();
  const entries: Array<{ outcome: string; args: unknown; error?: string }> = [];
  const schema = Type.Object({ mode: Type.String(), secret: Type.String() });
  const tool = {
    name: "external_test",
    label: "external_test",
    description: "test",
    parameters: schema,
    async execute(_id: string, params: { mode: string; secret: string }) {
      if (params.mode === "throw") throw new Error("boom");
      return {
        content: [{ type: "text" as const, text: params.mode === "encoded" ? "remote failed" : "ok" }],
        details: {},
        ...(params.mode === "encoded" ? { isError: true } : {}),
      };
    },
  };
  const wrapped = audited.withToolAudit(tool, {
    summarizeArgs: (params: { mode: string }) => ({ mode: params.mode }),
    audit: async (entry: { outcome: string; args: unknown; error?: string }) => {
      entries.push(entry);
    },
  });

  try {
    assert.equal((await wrapped.execute("1", { mode: "ok", secret: "do-not-log" })).content[0].type, "text");
    await wrapped.execute("2", { mode: "encoded", secret: "do-not-log" });
    await assert.rejects(wrapped.execute("3", { mode: "throw", secret: "do-not-log" }), /boom/);

    assert.deepEqual(
      entries.map((entry) => entry.outcome),
      ["ok", "error", "error"],
    );
    assert.match(entries[1].error ?? "", /remote failed/);
    assert.match(entries[2].error ?? "", /boom/);
    assert.doesNotMatch(JSON.stringify(entries), /do-not-log/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("audit writer failure cannot change a completed tool result", async () => {
  const { dataDir, audited } = await loadAuditWrapper();
  const schema = Type.Object({ value: Type.String() });
  const wrapped = audited.withToolAudit(
    {
      name: "external_test",
      label: "external_test",
      description: "test",
      parameters: schema,
      async execute() {
        return { content: [{ type: "text" as const, text: "completed" }], details: {} };
      },
    },
    {
      summarizeArgs: () => ({}),
      audit: async () => {
        throw new Error("audit disk unavailable");
      },
    },
  );
  try {
    const result = await wrapped.execute("1", { value: "x" });
    assert.deepEqual(result.content, [{ type: "text", text: "completed" }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
