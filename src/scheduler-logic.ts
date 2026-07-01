import type { Config } from "./config-schema.js";

export type RecurringTask = Config["scheduler"]["tasks"][number];
export type OneTimeTask = {
  id: string;
  name: string;
  run_at: string;
  prompt: string;
  notify: "always" | "on_issue" | "never";
  provider?: "codex" | "anthropic" | "openrouter";
  model?: string;
};
export type SchedulerJob = RecurringTask | OneTimeTask;

export function isOneTimeTask(task: SchedulerJob): task is OneTimeTask {
  return "run_at" in task;
}

export function taskSignature(task: SchedulerJob): string {
  return JSON.stringify(
    isOneTimeTask(task)
      ? {
          name: task.name,
          run_at: task.run_at,
          prompt: task.prompt,
          notify: task.notify,
          provider: task.provider,
          model: task.model,
        }
      : {
          name: task.name,
          schedule: task.schedule,
          prompt: task.prompt,
          notify: task.notify,
          provider: task.provider,
          model: task.model,
        },
  );
}

export function shouldNotify(task: SchedulerJob, success: boolean, output: string): boolean {
  if (task.notify === "never") return false;
  if (task.notify === "always") return true;
  if (!success) return true;

  const explicit = output.match(/^\s*NOTIFY:\s*(yes|no)\s*$/im);
  if (explicit) return explicit[1].toLowerCase() === "yes";

  const lower = output.toLowerCase();
  return ["warning", "error", "critical", "down", "fail", "issue", "alert"].some((word) => lower.includes(word));
}
