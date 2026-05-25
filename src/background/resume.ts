import { resumeBackgroundTask } from "./manager.js";

async function main(): Promise<void> {
  const taskId = process.argv[2]?.trim();
  const roleArg = process.argv[3]?.trim();
  if (!taskId || (roleArg && !["fixer", "reviewer"].includes(roleArg))) {
    throw new Error("usage: resume-background-task <task-id> [fixer|reviewer]");
  }

  const role = roleArg === "reviewer" ? "reviewer" : "fixer";
  const task = await resumeBackgroundTask(taskId, role);
  console.log(`Resumed ${task.id}; starting ${role}`);
  console.log(`Status: ${task.status}`);
  console.log(`Pipeline: ${task.pipeline.map((stage) => `${stage.role}:${stage.status}`).join(" -> ")}`);
  console.log(`Worktree: ${task.worktree}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
