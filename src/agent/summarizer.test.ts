import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@mariozechner/pi-ai";

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-summarizer-"));
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
      "  summarize_on_rotation: true",
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
  const summarizer = await import("./summarizer.js");
  const { paths } = await import("../paths.js");
  return { dataDir, paths, summarizer };
}

test("startup recovery skips failed newest archives without spending its success budget", async () => {
  const { dataDir, paths, summarizer } = await setup();
  try {
    await mkdir(paths.sessionsArchive, { recursive: true });
    // Directories with JSONL-looking names fail deterministically when loaded,
    // without requiring a provider call. They model permanently bad archives.
    for (const id of ["z-bad", "y-bad", "x-bad"]) {
      await mkdir(join(paths.sessionsArchive, `${id}.jsonl`));
    }
    for (const id of ["c-empty", "b-empty", "a-empty", "0-empty"]) {
      await writeFile(join(paths.sessionsArchive, `${id}.jsonl`), "", "utf-8");
    }

    await summarizer.resumeUnsummarizedArchives({ provider: "unused" } as Model<any>);

    for (const id of ["c-empty", "b-empty", "a-empty"]) {
      await access(join(paths.sessionsArchive, `${id}.summarized`));
    }
    await assert.rejects(access(join(paths.sessionsArchive, "0-empty.summarized")), { code: "ENOENT" });

    // The attempt cap is hard, but the persisted cursor makes the next startup
    // continue below a larger permanently bad prefix instead of retrying it.
    await rm(paths.sessionsArchive, { recursive: true, force: true });
    await mkdir(paths.sessionsArchive, { recursive: true });
    for (const id of ["z9-bad", "z8-bad", "z7-bad", "z6-bad", "z5-bad", "z4-bad", "z3-bad"]) {
      await mkdir(join(paths.sessionsArchive, `${id}.jsonl`));
    }
    await writeFile(join(paths.sessionsArchive, "a-good.jsonl"), "", "utf-8");

    await summarizer.resumeUnsummarizedArchives({ provider: "unused" } as Model<any>);
    const firstCursor = JSON.parse(await readFile(join(paths.sessionsArchive, ".summary-resume.json"), "utf-8")) as {
      last_attempted: string;
    };
    assert.equal(firstCursor.last_attempted, "z4-bad.jsonl");
    await assert.rejects(access(join(paths.sessionsArchive, "a-good.summarized")), { code: "ENOENT" });

    await summarizer.resumeUnsummarizedArchives({ provider: "unused" } as Model<any>);
    await access(join(paths.sessionsArchive, "a-good.summarized"));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
