import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackgroundTask } from "./types.js";

async function prepare() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-background-lifecycle-"));
  const worktreesDir = join(dataDir, "worktrees");
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.JARVIS_BACKGROUND_WORKTREES_DIR = worktreesDir;
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
      "background:",
      "  max_concurrent_workers: 2",
      "  role_models: {}",
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
      "  telegram_chat_id: 123",
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
  const manager = await import("./manager.js");
  const lifecycle = await import("./lifecycle-notifications.js");
  const notifications = await import("../lib/internal-notifications.js");
  return { dataDir, worktreesDir, lifecycle, manager, notifications };
}

function reviewerRejectedTask(): BackgroundTask {
  const timestamp = new Date().toISOString();
  return {
    id: "fern-sparrow",
    uuid: "uuid-fern-sparrow",
    name: "reviewed task",
    status: "queued",
    prompt: "test",
    repo: process.cwd(),
    worktree: join(tmpdir(), "fern-sparrow"),
    branch: "worker/fern-sparrow",
    chat_id: 123,
    pipeline: [
      { role: "implementer", status: "done" },
      { role: "reviewer", status: "done", summary: "VERDICT: needs_fix\nMissing regression test." },
      { role: "fixer", status: "queued" },
    ],
    current_role: "fixer",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("reviewer needs_fix is durably surfaced without a /tasks request", async () => {
  const { dataDir, worktreesDir, lifecycle, manager, notifications } = await prepare();
  try {
    const cases: Array<[BackgroundTask["status"], RegExp]> = [
      ["waiting_on_main", /\/answer fern-sparrow/],
      ["needs_fix", /\/fixbg fern-sparrow/],
      ["ready_for_pr", /prepare the PR/],
      ["failed", /\/fixbg fern-sparrow/],
      ["done", /inspect the worktree/],
    ];
    for (const [status, nextAction] of cases) {
      const transition = reviewerRejectedTask();
      transition.status = status;
      const notification = lifecycle.queueBackgroundStatusNotification(transition);
      assert.ok(notification, `expected ${status} notification`);
      assert.match(notification!.body, /Next action:/);
      assert.match(notification!.body, nextAction);
    }

    const task = reviewerRejectedTask();
    // This is the same reviewer-rejection transition used before the worker
    // launches its automatic fixer/re-review cycle.
    lifecycle.queueReviewerNeedsFix(task);
    await manager.writeBackgroundTask(task);
    await notifications.writeInternalNotificationHeartbeat();

    // This is the worker/supervisor path; no owner command is needed to make
    // the reviewer rejection visible to the main Telegram notification pump.
    await lifecycle.enqueueBackgroundLifecycleNotifications(task.id);
    await lifecycle.enqueueBackgroundLifecycleNotifications(task.id);

    const pending = await notifications.listPendingInternalNotifications();
    const rejection = pending.filter(
      (notification: { source: string; title: string }) =>
        notification.source === "background" && notification.title === `${task.id} review needs fixes`,
    );
    assert.equal(rejection.length, 1);
    assert.match(rejection[0].body, /Next action:/);

    const stored = await manager.readBackgroundTask(task.id);
    assert.ok(stored.lifecycle_notifications?.[0].enqueued_at);

    // Preparation failures are also prompt failed lifecycle transitions, not
    // a legacy terminal slot that waits for supervisor reconciliation.
    await assert.rejects(
      manager.startBackgroundTask("preparation failure", 123, join(dataDir, "missing-repo")),
      /git|not a git repository|ENOENT/i,
    );
    const failed = (await manager.listBackgroundTasks()).find(
      (candidate: BackgroundTask) => candidate.name === "preparation failure" && candidate.status === "failed",
    );
    assert.ok(failed?.lifecycle_notifications?.some((notification) => notification.event === "terminal-failed"));
    // The failure reaches git with a fresh, test-local worktree path instead
    // of colliding with a task directory from a prior test or live worker.
    assert.ok(failed?.worktree.startsWith(`${worktreesDir}/`));
    assert.doesNotMatch(failed?.error ?? "", /worktree already exists/);
    const failedNotification = (await notifications.listPendingInternalNotifications()).find(
      (notification: { source: string; title: string; body: string }) =>
        notification.source === "background" && notification.title === `${failed!.id} failed`,
    );
    assert.ok(failedNotification);
    assert.match(failedNotification.body, /Next action:/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
