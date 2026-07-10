import { config } from "../config.js";
import { startBackgroundTask } from "./manager.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const chatFlag = args.indexOf("--chat-id");
  let chatId = config.scheduler.telegram_chat_id;
  if (chatFlag >= 0) {
    const raw = args[chatFlag + 1];
    chatId = Number(raw);
    args.splice(chatFlag, 2);
  }
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error("usage: start-background-task --chat-id <telegram-chat-id> <prompt>");
  }
  const prompt = args.join(" ").trim();
  if (!prompt) throw new Error("usage: start-background-task --chat-id <telegram-chat-id> <prompt>");
  const task = await startBackgroundTask(prompt, chatId);
  console.log(`Started ${task.id}`);
  console.log(`Worktree: ${task.worktree}`);
  console.log(`Branch: ${task.branch}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
