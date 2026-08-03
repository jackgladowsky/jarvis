import { resumeBackgroundTask } from "./manager.js";

async function main(): Promise<void> {
  const taskId = process.argv[2]?.trim();
  if (!taskId || process.argv[3]) throw new Error("usage: resume-background-task <task-id>");

  const task = await resumeBackgroundTask(taskId);
  console.log(`Resumed ${task.id}; single worker starting`);
  console.log(`Status: ${task.status}`);
  console.log(`Worktree: ${task.worktree}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
