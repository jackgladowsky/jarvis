import test from "node:test";
import assert from "node:assert/strict";
import { canStartGoalTask, classifyChildResult, goalDeadline, normalizeGoalBudgets, parseGoalStartArgs } from "./logic.js";
import type { GoalState } from "./types.js";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  const created = "2026-01-01T00:00:00.000Z";
  return {
    id: "goal-fern-sparrow",
    uuid: "uuid",
    name: "Improve JARVIS",
    objective: "Improve JARVIS",
    chat_id: 123,
    status: "active",
    budgets: normalizeGoalBudgets({ maxTasks: 2, maxMinutes: 60, maxFailures: 0 }),
    tasks_started: 0,
    failures: 0,
    task_ids: [],
    created_at: created,
    updated_at: created,
    deadline_at: "2999-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("parseGoalStartArgs extracts budgets and objective", () => {
  assert.deepEqual(parseGoalStartArgs("--max-tasks 3 --max-minutes 45 --max-failures 1 --auto tighten tests"), {
    objective: "tighten tests",
    options: { maxTasks: 3, maxMinutes: 45, maxFailures: 1, autoContinue: true },
  });
  assert.deepEqual(parseGoalStartArgs("\"ship a small thing\""), {
    objective: "ship a small thing",
    options: {},
  });
  assert.equal(parseGoalStartArgs("--max-tasks nope improve"), undefined);
});

test("normalizeGoalBudgets applies safe defaults and bounds", () => {
  assert.deepEqual(normalizeGoalBudgets(), {
    max_tasks: 1,
    max_minutes: 120,
    max_failures: 0,
    auto_continue: false,
  });
  assert.deepEqual(normalizeGoalBudgets({ maxTasks: 999, maxMinutes: -5, maxFailures: -1, autoContinue: true }), {
    max_tasks: 20,
    max_minutes: 1,
    max_failures: 0,
    auto_continue: true,
  });
});

test("canStartGoalTask enforces one active task and budgets", () => {
  assert.deepEqual(canStartGoalTask(goal()), { ok: true });
  assert.match((canStartGoalTask(goal({ active_task_id: "fern-sparrow" })) as { ok: false; reason: string }).reason, /already active/);
  assert.deepEqual(canStartGoalTask(goal({ tasks_started: 2 })), {
    ok: false,
    reason: "task budget exhausted (2/2)",
    done: true,
  });
  assert.deepEqual(canStartGoalTask(goal({ deadline_at: "2025-01-01T00:00:00.000Z" }), new Date("2026-01-01T00:00:00.000Z")), {
    ok: false,
    reason: "time budget exhausted",
    done: true,
  });
});

test("classifyChildResult maps terminal background statuses", () => {
  assert.equal(classifyChildResult({ status: "ready_for_pr" }), "ready");
  assert.equal(classifyChildResult({ status: "needs_fix" }), "blocked");
  assert.equal(classifyChildResult({ status: "waiting_on_main" }), "blocked");
  assert.equal(classifyChildResult({ status: "failed" }), "failed");
});
