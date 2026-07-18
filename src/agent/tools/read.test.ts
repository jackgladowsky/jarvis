import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadReadTool() {
  const data = await mkdtemp(join(tmpdir(), "jarvis-read-"));
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
      "logging: { audit_log_enabled: false, audit_log_max_value_bytes: 2048, audit_log_redact_patterns: true, level: info }",
    ].join("\n"),
  );
  return { data, readTool: (await import("./read.js")).readTool };
}

function text(result: Awaited<ReturnType<Awaited<ReturnType<typeof loadReadTool>>["readTool"]["execute"]>>): string {
  const first = result.content[0];
  return first.type === "text" ? first.text : "";
}

test("million-character log is bounded and repeatable with continuation cursor", async () => {
  const { data, readTool } = await loadReadTool();
  const file = join(data, "million.log");
  await writeFile(file, `${"x".repeat(1_000_000)}\nsecond\n`);
  const first = await readTool.execute("r1", { path: file }, undefined);
  assert.ok(Buffer.byteLength(text(first)) < 52 * 1024);
  assert.equal((first.details as { truncated: boolean }).truncated, true);
  const cursor = (first.details as { cursor?: string }).cursor;
  assert.ok(cursor);
  const second = await readTool.execute("r2", { path: file, cursor }, undefined);
  assert.ok(Buffer.byteLength(text(second)) < 52 * 1024);
  assert.notEqual((second.details as { sha256: string }).sha256, "");
});

test("read preserves UTF-8 boundaries and line offsets", async () => {
  const { data, readTool } = await loadReadTool();
  const file = join(data, "utf8.txt");
  await writeFile(file, `zero\n${"🙂".repeat(20_000)}\nlast\n`);
  const result = await readTool.execute("r", { path: file, offset: 2, limit: 1 }, undefined);
  const body = text(result).split("\n\n[truncated:")[0];
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(body)));
  assert.ok(body.startsWith("🙂"));
});

test("continuation cursor rejects a changed file", async () => {
  const { data, readTool } = await loadReadTool();
  const file = join(data, "changing.log");
  await writeFile(file, "x".repeat(100_000));
  const first = await readTool.execute("r1", { path: file }, undefined);
  const cursor = (first.details as { cursor?: string }).cursor;
  assert.ok(cursor);
  await appendFile(file, "changed");
  await assert.rejects(readTool.execute("r2", { path: file, cursor }, undefined), /stale read continuation cursor/);
});

test("read rejects binary files", async () => {
  const { data, readTool } = await loadReadTool();
  const file = join(data, "binary.bin");
  await writeFile(file, Buffer.from([1, 2, 0, 4]));
  await assert.rejects(readTool.execute("r", { path: file }, undefined), /binary file/);
});
