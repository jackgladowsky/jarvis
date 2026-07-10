import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackgroundTask } from "../background/types.js";
import type { GoalState } from "./types.js";

async function prepare() {
  const dataDir = await mkdtemp(join(tmpdir(), "jarvis-goal-manager-"));
  process.env.JARVIS_DATA_DIR = dataDir;
  process.env.JARVIS_SOURCE_ROOT = process.cwd();
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
  const goals = await import("./manager.js");
  const background = await import("../background/manager.js");
  return { dataDir, goals, background };
}

function makeGoal(taskId: string): GoalState {
  const timestamp = new Date().toISOString();
  return {
    id: "goal-test-goal",
    uuid: "goal-uuid",
    name: "test goal",
    objective: "test reliability",
    chat_id: 123,
    status: "active",
    budgets: { max_tasks: 3, max_minutes: 60, max_failures: 1, auto_continue: false },
    tasks_started: 1,
    failures: 0,
    task_ids: [taskId],
    active_task_id: taskId,
    created_at: timestamp,
    updated_at: timestamp,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function failedTask(id: string, goalId: string): BackgroundTask {
  const timestamp = new Date().toISOString();
  return {
    id,
    uuid: `uuid-${id}`,
    name: id,
    status: "failed",
    prompt: "test",
    repo: process.cwd(),
    worktree: join(tmpdir(), id),
    branch: `worker/${id}`,
    chat_id: 123,
    pipeline: [{ role: "implementer", status: "failed" }],
    goal_id: goalId,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("goal advancement is idempotent, CAS-protected, and honors the failure budget", async () => {
  const { dataDir, goals, background } = await prepare();
  try {
    const firstTask = failedTask("failed-one", "goal-test-goal");
    await background.writeBackgroundTask(firstTask);
    await goals.writeGoal(makeGoal(firstTask.id));

    await Promise.all([
      goals.advanceGoalAfterBackgroundTask(firstTask.id),
      goals.advanceGoalAfterBackgroundTask(firstTask.id),
    ]);
    let current = await goals.readGoal("goal-test-goal");
    assert.equal(current.failures, 1);
    assert.equal(current.status, "waiting_on_approval");
    assert.equal(current.active_task_id, undefined);

    const winner = await goals.readGoal(current.id);
    const stale = await goals.readGoal(current.id);
    winner.name = "winner";
    await goals.writeGoal(winner);
    stale.name = "lost";
    await assert.rejects(goals.writeGoal(stale), /changed concurrently/);
    await assert.rejects(goals.readGoal("../escape"), /invalid goal id/);

    const secondTask = failedTask("failed-two", current.id);
    await background.writeBackgroundTask(secondTask);
    current = await goals.readGoal(current.id);
    current.status = "active";
    current.active_task_id = secondTask.id;
    current.tasks_started = 2;
    current.task_ids.push(secondTask.id);
    await goals.writeGoal(current);
    const terminal = await goals.advanceGoalAfterBackgroundTask(secondTask.id);
    assert.equal(terminal?.failures, 2);
    assert.equal(terminal?.status, "failed");
    assert.match(terminal?.stop_reason ?? "", /failure budget exhausted/);

    const eventFile = join(dataDir, "data", "goals", "events", `${current.id}.jsonl`);
    await appendFile(eventFile, '{"partial":', "utf-8");
    assert.ok((await goals.readGoalEvents(current.id)).length > 0);
    assert.ok((await readdir(join(dataDir, "data", "goals", "events"))).some((entry) => entry.includes(".corrupt-")));

    const corruptGoal = join(dataDir, "data", "goals", "tasks", "goal-bad-state.json");
    await writeFile(corruptGoal, "{", "utf-8");
    assert.ok((await goals.listGoals()).some((goal) => goal.id === current.id));

    const blockedTask = failedTask("waiting-child", "goal-blocked-case");
    blockedTask.status = "waiting_on_main";
    const blockedGoal = makeGoal(blockedTask.id);
    blockedGoal.id = "goal-blocked-case";
    blockedGoal.uuid = "blocked-goal-uuid";
    await background.writeBackgroundTask(blockedTask);
    await goals.writeGoal(blockedGoal);
    await goals.advanceGoalAfterBackgroundTask(blockedTask.id);
    await goals.advanceGoalAfterBackgroundTask(blockedTask.id);
    const blocked = await goals.readGoal(blockedGoal.id);
    assert.equal(blocked.status, "waiting_on_approval");
    assert.equal(blocked.active_task_id, blockedTask.id);
    await assert.rejects(goals.startNextGoalTask(blockedGoal.id), /already has active task/);
    const resumedBlocked = await goals.resumeGoal(blockedGoal.id);
    assert.equal(resumedBlocked.status, "active");
    assert.equal(resumedBlocked.active_task_id, blockedTask.id);

    const emptyPaused = makeGoal("unused-child");
    emptyPaused.id = "goal-resume-empty";
    emptyPaused.uuid = "empty-goal-uuid";
    emptyPaused.status = "paused";
    emptyPaused.active_task_id = undefined;
    emptyPaused.task_ids = [];
    emptyPaused.tasks_started = emptyPaused.budgets.max_tasks;
    emptyPaused.stop_reason = "paused for test";
    await goals.writeGoal(emptyPaused);
    const resumedEmpty = await goals.resumeGoal(emptyPaused.id);
    assert.equal(resumedEmpty.status, "done");
    assert.match(resumedEmpty.stop_reason ?? "", /task budget exhausted/);

    const expiredTask = failedTask("expired-child", "goal-expired-case");
    expiredTask.status = "queued";
    expiredTask.pipeline = [{ role: "implementer", status: "queued" }];
    expiredTask.launch_deferred = true;
    const expiredGoal = makeGoal(expiredTask.id);
    expiredGoal.id = "goal-expired-case";
    expiredGoal.uuid = "expired-goal-uuid";
    expiredGoal.deadline_at = new Date(Date.now() - 60_000).toISOString();
    await background.writeBackgroundTask(expiredTask);
    await goals.writeGoal(expiredGoal);

    const orphan = failedTask("paused-orphan", "goal-paused-case");
    orphan.status = "queued";
    orphan.pipeline = [{ role: "implementer", status: "queued" }];
    orphan.launch_deferred = true;
    const pausedGoal = makeGoal("pending:stale-reservation");
    pausedGoal.id = "goal-paused-case";
    pausedGoal.uuid = "paused-goal-uuid";
    pausedGoal.status = "paused";
    pausedGoal.task_ids = [];
    await background.writeBackgroundTask(orphan);
    await goals.writeGoal(pausedGoal);
    pausedGoal.updated_at = new Date(Date.now() - 20 * 60_000).toISOString();
    await writeFile(
      join(dataDir, "data", "goals", "tasks", `${pausedGoal.id}.json`),
      `${JSON.stringify(pausedGoal, null, 2)}\n`,
      "utf-8",
    );

    await goals.reconcileGoals();
    const expiredAfter = await goals.readGoal(expiredGoal.id);
    assert.equal(expiredAfter.status, "stopped");
    assert.equal(expiredAfter.active_task_id, undefined);
    assert.equal((await background.readBackgroundTask(expiredTask.id)).status, "cancelled");

    const pausedAfter = await goals.readGoal(pausedGoal.id);
    assert.equal(pausedAfter.status, "paused");
    assert.equal(pausedAfter.active_task_id, undefined);
    assert.equal(pausedAfter.tasks_started, 0);
    assert.equal((await background.readBackgroundTask(orphan.id)).status, "cancelled");

    const crashGoal = makeGoal("unused-child");
    crashGoal.id = "goal-crash-start";
    crashGoal.uuid = "crash-goal-uuid";
    crashGoal.active_task_id = undefined;
    crashGoal.task_ids = [];
    crashGoal.tasks_started = 0;
    crashGoal.initial_task_pending = true;
    await goals.writeGoal(crashGoal);
    let recoveredStarts = 0;
    const startInitialTask = async (goalId: string) => {
      recoveredStarts += 1;
      const recovered = await goals.readGoal(goalId);
      recovered.initial_task_pending = undefined;
      recovered.tasks_started = 1;
      recovered.active_task_id = "pending:recovered-in-test";
      await goals.writeGoal(recovered);
      return recovered;
    };
    await goals.reconcileGoals({ startInitialTask });
    await goals.reconcileGoals({ startInitialTask });
    assert.equal(recoveredStarts, 1);
    assert.equal((await goals.readGoal(crashGoal.id)).active_task_id, "pending:recovered-in-test");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
