import { config } from "../config.js";
import { startPrCiWatch } from "./service.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args[0] !== "start")
    throw new Error("usage: pr-ci-watch start --repo owner/name --pr NUMBER --head SHA [--chat-id ID]");
  const state = await startPrCiWatch({
    repository: value("--repo") ?? "",
    pr_number: Number(value("--pr")),
    head_sha: value("--head") ?? "",
    chat_id: Number(value("--chat-id") ?? config.scheduler.telegram_chat_id),
  });
  console.log(`Watching PR #${state.pr_number} at ${state.head_sha}`);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
