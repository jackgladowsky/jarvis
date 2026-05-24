import { config } from "../config.js";
import { startBackgroundTask } from "./manager.js";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) throw new Error("usage: start-background-task <prompt>");
  const task = await startBackgroundTask(prompt, config.scheduler.telegram_chat_id);
  console.log(`Started ${task.id}`);
  console.log(`Worktree: ${task.worktree}`);
  console.log(`Branch: ${task.branch}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
