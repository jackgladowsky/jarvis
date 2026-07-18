import assert from "node:assert/strict";
import { access, appendFile, mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

async function prepareSessionManager() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-session-test-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
  process.env.EXA_API_KEY = "exa-key";
  await mkdir(join(dataDir, "prompts"), { recursive: true });
  await writeFile(join(dataDir, "prompts", "system.md"), "test prompt", "utf-8");
  await writeFile(
    join(dataDir, "config.yaml"),
    [
      "agent:",
      "  provider: codex",
      "  model: gpt-5.1",
      "session:",
      "  inactivity_threshold_minutes: 60",
      "  max_duration_hours: 24",
      "  summarize_on_rotation: false",
      "  announce_new_session: false",
      "compaction:",
      "  enabled: true",
      "  reserve_tokens: 100",
      "  keep_recent_tokens: 10",
      "tools:",
      "  bash:",
      "    default_timeout_seconds: 30",
      "    max_timeout_seconds: 120",
      "telegram:",
      "  show_typing: false",
      "  long_tool_call_seconds: 5",
      "  parse_mode: none",
      "stt:",
      "  provider: disabled",
      "  local_whisper_cpp:",
      "    whisper_binary_path: /tmp/whisper-cli",
      "    model_path: /tmp/ggml-base.en.bin",
      "    ffmpeg_path: /usr/bin/ffmpeg",
      "    max_audio_mb: 25",
      "    timeout_seconds: 120",
      "scheduler:",
      "  enabled: false",
      "  timezone: UTC",
      "  telegram_chat_id: 0",
      "  tasks: []",
      "logging:",
      "  audit_log_enabled: false",
      "  audit_log_max_value_bytes: 2048",
      "  audit_log_redact_patterns: true",
      "  level: info",
      "",
    ].join("\n"),
    "utf-8",
  );
  const manager = await import("./session-manager.js");
  await manager.init();
  return { manager, dataDir };
}

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

test("chat compaction checkpoint preserves canonical history and derives recent tail", async () => {
  const { manager, dataDir } = await prepareSessionManager();
  const { sessionId } = await manager.resolveSession(123);
  assert.match(
    sessionId,
    /^\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const canonical = [
    user("old question"),
    assistant("old answer"),
    user("recent question"),
    assistant("recent answer"),
  ];
  const keptTail = canonical.slice(2);
  await manager.appendMessages(sessionId, canonical);

  await manager.appendSessionCompaction(sessionId, {
    summary: "older conversation summary",
    tokensBefore: 5000,
    keepFromMessage: 2,
    sourceThroughMessage: 3,
  });

  const loaded = await manager.load(sessionId);
  assert.equal(loaded.previousSummary, "older conversation summary");
  assert.deepEqual(loaded.tail, keptTail);

  const sessionFile = join(dataDir, "data", "sessions", `${sessionId}.jsonl`);
  const canonicalRaw = await readFile(sessionFile, "utf-8");
  assert.match(canonicalRaw, /old question/);
  assert.match(canonicalRaw, /old answer/);
  assert.equal(canonicalRaw.trimEnd().split("\n").length, 5);
  await appendFile(sessionFile, '{"role":"assistant","content":', "utf-8");
  const recovered = await manager.load(sessionId);
  assert.deepEqual(recovered.tail, keptTail);
  assert.ok((await readdir(join(dataDir, "data", "sessions"))).some((entry) => entry.includes(".corrupt-")));

  await Promise.all([manager.resolveSession(456), manager.resolveSession(789)]);
  const active = JSON.parse(await readFile(join(dataDir, "data", "sessions", "active.json"), "utf-8")) as Record<
    string,
    unknown
  >;
  assert.ok(active["123"]);
  assert.ok(active["456"]);
  assert.ok(active["789"]);
  const owners = JSON.parse(await readFile(join(dataDir, "data", "sessions", "owners.json"), "utf-8")) as Record<
    string,
    number
  >;
  assert.equal(owners[sessionId], 123);
  assert.equal(owners[(active["456"] as { sessionId: string }).sessionId], 456);
  assert.equal(owners[(active["789"] as { sessionId: string }).sessionId], 789);

  const orphan = join(dataDir, "data", "sessions", "orphan-session.jsonl");
  await writeFile(orphan, `${JSON.stringify(user("unreferenced"))}\n`, "utf-8");
  const conflictingOrphan = join(dataDir, "data", "sessions", "conflict-session.jsonl");
  await writeFile(conflictingOrphan, `${JSON.stringify(user("live conflict"))}\n`, "utf-8");
  await writeFile(
    join(dataDir, "data", "sessions", "archive", "conflict-session.jsonl"),
    `${JSON.stringify(user("existing archive"))}\n`,
    "utf-8",
  );
  await unlink(sessionFile);
  await manager.init();
  const repaired = manager.getActiveSession(123);
  assert.ok(repaired);
  assert.notEqual(repaired.sessionId, sessionId);
  await access(join(dataDir, "data", "sessions", `${repaired.sessionId}.jsonl`));
  await assert.rejects(access(orphan), { code: "ENOENT" });
  await access(join(dataDir, "data", "sessions", "archive", "orphan-session.jsonl"));
  await assert.rejects(access(conflictingOrphan), { code: "ENOENT" });
  assert.ok(
    (await readdir(join(dataDir, "data", "sessions", "archive"))).some((entry) =>
      entry.startsWith("conflict-session.conflict-"),
    ),
  );
});
