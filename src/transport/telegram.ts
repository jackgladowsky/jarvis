import { Bot } from "grammy";
import { env } from "../config.js";
import { isAllowed } from "../lib/allowlist.js";
import { log } from "../lib/logger.js";

type Handler = (text: string) => Promise<string>;

export async function runTelegram(handle: Handler): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined || !isAllowed(userId)) {
      log.warn("dropped non-allowlisted message", { userId, chatId: ctx.chat.id });
      return;
    }
    try {
      const reply = await handle(ctx.message.text);
      await ctx.reply(reply);
    } catch (err) {
      log.error("handler error", err);
      await ctx.reply("Something went wrong.").catch(() => {
        /* ignore */
      });
    }
  });

  const shutdown = (sig: string) => {
    log.info("telegram bot stopping", { sig });
    void bot.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  log.info("telegram bot starting (long-poll)");
  await bot.start();
  log.info("telegram bot stopped");
}
