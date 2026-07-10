import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadFileTools() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-file-tools-"));
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
  const [{ writeTool }, { editTool }] = await Promise.all([import("./write.js"), import("./edit.js")]);
  return { dataDir, writeTool, editTool };
}

test("write and edit reject symbolic-link destinations without touching their targets", async () => {
  const { dataDir, writeTool, editTool } = await loadFileTools();
  try {
    const target = join(dataDir, "target.txt");
    const link = join(dataDir, "link.txt");
    await writeFile(target, "original", "utf-8");
    await symlink(target, link);

    await assert.rejects(
      writeTool.execute("write-1", { path: link, content: "replacement" }, undefined),
      /symbolic link/,
    );
    await assert.rejects(
      editTool.execute("edit-1", { path: link, oldText: "original", newText: "replacement" }, undefined),
      /symbolic link/,
    );

    assert.equal(await readFile(target, "utf-8"), "original");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
