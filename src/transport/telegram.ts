// Telegram transport layer.
//
// Responsibilities:
//   1. Long-poll Telegram for incoming messages (grammy handles the API).
//   2. Drop messages from non-allowlisted users — DESIGN.md §12.
//   3. Serialize concurrent messages from the same chat via withLock — §10.
//   4. Hand the message text to the agent runtime, reply with its output.
//   5. Stop cleanly on SIGINT/SIGTERM so systemd restarts don't strand polls.
//
// Anything fancier (typing indicators, edit-streaming for long replies,
// MarkdownV2, /cancel) is deferred — see DESIGN.md §12 and open questions.

import { Bot } from "grammy";
import { env } from "../config.js";
import { isAllowed } from "../lib/allowlist.js";
import { log } from "../lib/logger.js";
import { withLock } from "../lib/mutex.js";

type Handler = (text: string) => Promise<string>;

export async function runTelegram(handle: Handler): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Single message handler. grammy invokes this concurrently for separate
  // chats by default, which is fine — the per-chat lock below prevents
  // interleaving within a single chat.
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    // Allowlist check happens before any work — drop silently for non-allowed
    // users so we don't even acknowledge the bot exists. Logging the userId
    // makes it easy to add a friend later by tailing journalctl.
    if (userId === undefined || !isAllowed(userId)) {
      log.warn("dropped non-allowlisted message", { userId, chatId });
      return;
    }

    // Per-chat serialization. If a previous message from this chat is still
    // running, this call queues behind it until the agent finishes that turn.
    await withLock(chatId, async () => {
      try {
        const reply = await handle(ctx.message.text);
        await ctx.reply(reply);
      } catch (err) {
        log.error("handler error", err);
        // Best-effort error reply. Swallow secondary failures so a broken
        // bot connection doesn't escalate inside the catch.
        await ctx.reply("Something went wrong.").catch(() => {
          /* ignore */
        });
      }
    });
  });

  // Graceful shutdown — important for systemd `Restart=on-failure` to behave
  // (otherwise a SIGTERM during long-poll would leak the polling loop).
  const shutdown = (sig: string) => {
    log.info("telegram bot stopping", { sig });
    void bot.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  log.info("telegram bot starting (long-poll)");
  // bot.start() resolves only when bot.stop() is called. The promise drives
  // the lifetime of the process from index.ts.
  await bot.start();
  log.info("telegram bot stopped");
}
