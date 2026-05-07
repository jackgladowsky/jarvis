// Telegram transport layer.
//
// Responsibilities:
//   1. Long-poll Telegram for incoming messages (grammy handles the API).
//   2. Drop messages from non-allowlisted users — DESIGN.md §12.
//   3. Serialize concurrent messages from the same chat via withLock — §10.
//   4. Drive the agent runtime with streaming callbacks:
//        - typing indicator while the agent is processing
//        - placeholder + debounced edits to stream the final response
//        - delete a placeholder if its message turned into a tool call
//      The user sees only typing → final answer; tool-call messages and
//      "let me check…" filler stay invisible.
//   5. Stop cleanly on SIGINT/SIGTERM so systemd restarts don't strand polls.

import { Bot, type Context } from "grammy";
import { handleMessage, rotateSession } from "../agent/runtime.js";
import { config, env } from "../config.js";
import { isAllowed } from "../lib/allowlist.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "../lib/format.js";
import { log } from "../lib/logger.js";
import { withLock } from "../lib/mutex.js";

type Handler = typeof handleMessage;

// Telegram expires the typing indicator after ~5s; re-fire every 4s while
// the agent is working so it stays visible without flickering.
const TYPING_REFIRE_MS = 4000;

// Minimum spacing between consecutive `editMessageText` calls on the same
// placeholder. Telegram's per-chat edit rate limit is ~1/sec; 1.5s gives us
// margin and keeps the UI from stuttering.
const EDIT_DEBOUNCE_MS = 1500;

// Convert agent text to whatever Telegram expects, depending on parse_mode.
// Skipping the conversion when parse_mode === "none" keeps the bot strictly
// equivalent to Phase 3's behavior if Jack ever wants to bisect a regression.
function format(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  const mode = config.telegram.parse_mode;
  if (mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" }; // user opt-in; no escaping helper
  return { text };
}

function chunks(text: string): string[] {
  return config.telegram.parse_mode === "HTML"
    ? splitTelegramMarkdown(text)
    : splitTelegramMarkdown(text);
}

// Wraps grammy's reply/edit calls so failures (rate limits, network) don't
// take down the agent run — we just log and move on. The next debounced edit
// or the message_end final flush will catch up.
async function safe<T>(label: string, p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    log.debug("telegram call failed", { label, err: err instanceof Error ? err.message : err });
    return undefined;
  }
}

async function processMessage(ctx: Context, handle: Handler): Promise<void> {
  const chatId = ctx.chat!.id;
  const userText = ctx.message?.text ?? "";

  // ── Slash commands ──────────────────────────────────────────────────────
  // Intercept commands before the agent runs. Currently just `/new` — see
  // DESIGN.md §10. More commands can land here without touching the runtime.
  if (userText.trim() === "/new") {
    const sessionId = await rotateSession(chatId);
    await safe("reply (/new)", ctx.reply(`Started a new session (${sessionId}).`));
    return;
  }

  // ── Typing indicator ────────────────────────────────────────────────────
  // Fires immediately and then on a 4s loop until the agent run resolves.
  let active = true;
  const fireTyping = () => safe("typing", ctx.replyWithChatAction("typing"));
  if (config.telegram.show_typing) void fireTyping();
  const typingTimer = config.telegram.show_typing
    ? setInterval(() => {
        if (active) void fireTyping();
      }, TYPING_REFIRE_MS)
    : undefined;

  // ── Streaming placeholder state ─────────────────────────────────────────
  // `placeholder` is undefined until we send the first reply for the current
  // assistant message. After that, subsequent text updates are folded into
  // edits to the same Telegram message id.
  let placeholder: { messageId: number; lastSentText: string; lastEditAt: number } | undefined;
  // Set true while a `ctx.reply` is mid-flight so concurrent updates don't
  // race to send a second placeholder. Belt-and-suspenders alongside the
  // listener-await ordering in runtime.ts.
  let sending = false;
  // Pending debounced edit. Cleared when we flush early or finalize.
  let pendingEditTimer: NodeJS.Timeout | undefined;
  // Latest text accumulated since the last successful edit; used by the
  // debounce timer when it fires.
  let pendingEditText = "";

  const flushEdit = async (text: string): Promise<void> => {
    if (!placeholder || text === placeholder.lastSentText) return;
    const streamText = chunks(text)[0] ?? text;
    const formatted = format(streamText);
    const result = await safe(
      "editMessageText",
      ctx.api.editMessageText(chatId, placeholder.messageId, formatted.text, {
        parse_mode: formatted.parse_mode,
        link_preview_options: { is_disabled: true },
      }),
    );
    if (result !== undefined) {
      placeholder.lastSentText = text;
      placeholder.lastEditAt = Date.now();
    }
  };

  const cancelPendingEdit = () => {
    if (pendingEditTimer) {
      clearTimeout(pendingEditTimer);
      pendingEditTimer = undefined;
    }
  };

  const sendFinalChunks = async (text: string): Promise<void> => {
    const parts = chunks(text);
    const [first, ...rest] = parts;

    if (placeholder) {
      const formatted = format(first);
      await safe(
        "editMessageText (final chunk 1)",
        ctx.api.editMessageText(chatId, placeholder.messageId, formatted.text, {
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
        }),
      );
      placeholder = undefined;
    } else if (!sending) {
      const formatted = format(first);
      await safe(
        "reply (final chunk 1)",
        ctx.reply(formatted.text, {
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
        }),
      );
    }

    for (const part of rest) {
      const formatted = format(part);
      await safe(
        "reply (final chunk)",
        ctx.reply(formatted.text, {
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
        }),
      );
    }
  };

  // ── Run the agent with streaming callbacks ──────────────────────────────
  try {
    await handle(chatId, userText, {
      // Streaming text update for an in-progress text-only assistant message.
      // Either send the placeholder if we don't have one yet, or schedule a
      // debounced edit to the existing one.
      onAssistantUpdate: async (text: string) => {
        if (!placeholder && !sending) {
          sending = true;
          const formatted = format(chunks(text)[0] ?? text);
          const sent = await safe(
            "reply (placeholder)",
            ctx.reply(formatted.text, {
              parse_mode: formatted.parse_mode,
              link_preview_options: { is_disabled: true },
            }),
          );
          sending = false;
          if (sent) {
            placeholder = {
              messageId: sent.message_id,
              lastSentText: chunks(text)[0] ?? text,
              lastEditAt: Date.now(),
            };
          }
          return;
        }
        if (!placeholder) return; // still mid-send; next update will catch it

        const elapsed = Date.now() - placeholder.lastEditAt;
        if (elapsed >= EDIT_DEBOUNCE_MS) {
          cancelPendingEdit();
          await flushEdit(text);
        } else {
          // Schedule (or replace) a deferred edit so the latest text lands
          // even if no further updates arrive within the debounce window.
          pendingEditText = text;
          if (!pendingEditTimer) {
            pendingEditTimer = setTimeout(() => {
              pendingEditTimer = undefined;
              void flushEdit(pendingEditText);
            }, EDIT_DEBOUNCE_MS - elapsed);
          }
        }
      },

      // The text-only assistant message finished. Final flush, then reset
      // local state so a subsequent message in the same turn (rare with the
      // skip-tool-call rule) starts with a fresh placeholder.
      onAssistantEnd: async (text: string) => {
        cancelPendingEdit();
        await sendFinalChunks(text);
      },

      // A streaming text message just sprouted a tool call — discard our
      // placeholder so the user doesn't see the "let me check…" filler.
      onAbandon: async () => {
        cancelPendingEdit();
        if (placeholder) {
          const id = placeholder.messageId;
          placeholder = undefined;
          await safe("deleteMessage", ctx.api.deleteMessage(chatId, id));
        }
      },

      // The agent terminated this turn with stopReason "error" / "aborted".
      // Without this the user sees nothing — silent failures are the worst
      // kind of failure for a chat bot.
      onError: async (text: string) => {
        cancelPendingEdit();
        const body = `Error: ${text}`;
        if (placeholder) {
          const id = placeholder.messageId;
          placeholder = undefined;
          await safe(
            "editMessageText (error)",
            ctx.api.editMessageText(chatId, id, body),
          );
        } else if (!sending) {
          await safe("reply (agent error)", ctx.reply(body));
        }
      },
    });
  } catch (err) {
    log.error("handler error", { err: err instanceof Error ? err.message : err });
    cancelPendingEdit();
    await safe("reply (error)", ctx.reply("Something went wrong."));
  } finally {
    active = false;
    if (typingTimer) clearInterval(typingTimer);
    cancelPendingEdit();
  }
}

export async function runTelegram(handle: Handler): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    if (userId === undefined || !isAllowed(userId)) {
      log.warn("dropped non-allowlisted message", { userId, chatId });
      return;
    }
    log.info("inbound", { chatId, userId, len: ctx.message?.text?.length ?? 0 });
    // Per-chat serialization — see DESIGN.md §10.
    await withLock(chatId, () => processMessage(ctx, handle));
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
