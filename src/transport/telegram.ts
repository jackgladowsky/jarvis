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
import type { ImageContent } from "@mariozechner/pi-ai";
import { handleMessage } from "../agent/runtime.js";
import { config, env } from "../config.js";
import { isAllowed } from "../lib/allowlist.js";
import {
  formatTranscribedPrompt,
  maxAudioBytes,
  MissingLocalWhisperSetupError,
  selectTelegramAudioCandidate,
  transcribeWithLocalWhisperCpp,
  type TelegramAudioCandidate,
} from "../lib/audio-transcription.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "../lib/format.js";
import {
  claimInternalNotification,
  finishInternalNotification,
  listPendingInternalNotifications,
  renderInternalNotificationPrompt,
  sendTelegramFallback,
  writeInternalNotificationHeartbeat,
  type InternalNotification,
} from "../lib/internal-notifications.js";
import { log } from "../lib/logger.js";
import { withLock } from "../lib/mutex.js";
import "./commands/handlers/index.js";
import { botMenuCommands, findCommand } from "./commands/registry.js";
import { consumeSttBenchmarkNext, getStatusMode } from "./commands/handlers/state.js";

type Handler = typeof handleMessage;

// Telegram expires the typing indicator after ~5s; re-fire every 4s while
// the agent is working so it stays visible without flickering.
const TYPING_REFIRE_MS = 4000;

// Minimum spacing between consecutive `editMessageText` calls on the same
// placeholder. Telegram's per-chat edit rate limit is ~1/sec; 1.5s gives us
// margin and keeps the UI from stuttering.
const EDIT_DEBOUNCE_MS = 1500;
const STATUS_EDIT_DEBOUNCE_MS = 2500;
const INTERNAL_NOTIFICATION_POLL_MS = 3000;
const INTERNAL_NOTIFICATION_HEARTBEAT_MS = 5000;
const MAX_TELEGRAM_IMAGES = 4;
const MAX_TELEGRAM_IMAGE_BYTES = 10 * 1024 * 1024;

// Convert agent text to whatever Telegram expects, depending on parse_mode.
// Skipping the conversion when parse_mode === "none" keeps the bot strictly
// equivalent to Phase 3's behavior if the owner ever wants to bisect a regression.
function format(text: string): { text: string; parse_mode?: "HTML" | "MarkdownV2" } {
  const mode = config.telegram.parse_mode;
  if (mode === "HTML") return { text: markdownToTelegramHtml(text), parse_mode: "HTML" };
  if (mode === "MarkdownV2") return { text, parse_mode: "MarkdownV2" }; // user opt-in; no escaping helper
  return { text };
}

function chunks(text: string): string[] {
  return config.telegram.parse_mode === "HTML" ? splitTelegramMarkdown(text) : splitTelegramMarkdown(text);
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

function imageCandidateFileIds(ctx: Context): Array<{ fileId: string; mimeType: string; fileSize?: number }> {
  const message = ctx.message;
  const out: Array<{ fileId: string; mimeType: string; fileSize?: number }> = [];

  const photos = message?.photo ?? [];
  const bestPhoto = photos.at(-1);
  if (bestPhoto) {
    out.push({ fileId: bestPhoto.file_id, mimeType: "image/jpeg", fileSize: bestPhoto.file_size });
  }

  const document = message?.document;
  if (document?.mime_type?.startsWith("image/")) {
    out.push({ fileId: document.file_id, mimeType: document.mime_type, fileSize: document.file_size });
  }

  return out.slice(0, MAX_TELEGRAM_IMAGES);
}

async function downloadTelegramImage(
  ctx: Context,
  candidate: { fileId: string; mimeType: string; fileSize?: number },
): Promise<ImageContent> {
  if (candidate.fileSize && candidate.fileSize > MAX_TELEGRAM_IMAGE_BYTES) {
    throw new Error(`image is too large (${Math.ceil(candidate.fileSize / 1024 / 1024)} MB)`);
  }

  const file = await ctx.api.getFile(candidate.fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");

  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_TELEGRAM_IMAGE_BYTES) {
    throw new Error(`image is too large (${Math.ceil(buffer.byteLength / 1024 / 1024)} MB)`);
  }

  const responseMimeType = response.headers.get("content-type")?.split(";")[0];
  const mimeType = responseMimeType?.startsWith("image/") ? responseMimeType : candidate.mimeType;
  if (!mimeType.startsWith("image/"))
    throw new Error(`Telegram file was not an image (${responseMimeType ?? mimeType})`);

  return { type: "image", data: buffer.toString("base64"), mimeType };
}

async function readImages(ctx: Context): Promise<ImageContent[]> {
  const candidates = imageCandidateFileIds(ctx);
  if (candidates.length === 0) return [];
  return Promise.all(candidates.map((candidate) => downloadTelegramImage(ctx, candidate)));
}

function sttOptions() {
  return {
    provider: config.stt.provider,
    whisperBinaryPath: config.stt.local_whisper_cpp.whisper_binary_path,
    modelPath: config.stt.local_whisper_cpp.model_path,
    ffmpegPath: config.stt.local_whisper_cpp.ffmpeg_path,
    maxAudioMb: config.stt.local_whisper_cpp.max_audio_mb,
    timeoutSeconds: config.stt.local_whisper_cpp.timeout_seconds,
  };
}

async function downloadTelegramAudio(ctx: Context, candidate: TelegramAudioCandidate): Promise<Buffer> {
  const limit = maxAudioBytes(config.stt.local_whisper_cpp.max_audio_mb);
  if (candidate.fileSize && candidate.fileSize > limit) {
    throw new Error(
      `audio is too large (${Math.ceil(candidate.fileSize / 1024 / 1024)} MB; max ${config.stt.local_whisper_cpp.max_audio_mb} MB)`,
    );
  }

  const file = await ctx.api.getFile(candidate.fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");

  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > limit) {
    throw new Error(
      `audio is too large (${Math.ceil(buffer.byteLength / 1024 / 1024)} MB; max ${config.stt.local_whisper_cpp.max_audio_mb} MB)`,
    );
  }
  return buffer;
}

async function transcribeTelegramAudio(ctx: Context, candidate: TelegramAudioCandidate): Promise<string> {
  const options = sttOptions();
  if (options.provider !== "local-whisper-cpp") throw new MissingLocalWhisperSetupError();
  const audio = await downloadTelegramAudio(ctx, candidate);
  return transcribeWithLocalWhisperCpp(audio, candidate, options);
}

function siblingModelPath(currentPath: string, modelName: "base.en" | "small.en"): string {
  return currentPath.replace(/ggml-[^/]+\.bin$/, `ggml-${modelName}.bin`);
}

async function benchmarkTelegramAudio(
  ctx: Context,
  candidate: TelegramAudioCandidate,
  startedAtMs: number,
): Promise<void> {
  const options = sttOptions();
  if (options.provider !== "local-whisper-cpp") throw new MissingLocalWhisperSetupError();
  const audio = await downloadTelegramAudio(ctx, candidate);
  const models = [
    { label: "base.en", path: siblingModelPath(options.modelPath, "base.en") },
    { label: "small.en", path: siblingModelPath(options.modelPath, "small.en") },
  ];
  const results = await Promise.all(
    models.map(async (model) => {
      const modelStart = Date.now();
      try {
        const transcript = await transcribeWithLocalWhisperCpp(audio, candidate, { ...options, modelPath: model.path });
        return { ...model, ok: true as const, ms: Date.now() - modelStart, transcript };
      } catch (err) {
        return {
          ...model,
          ok: false as const,
          ms: Date.now() - modelStart,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const totalMs = Date.now() - startedAtMs;
  const body = [
    `STT benchmark (${candidate.kind})`,
    `First reply after: ${(totalMs / 1000).toFixed(2)}s`,
    "",
    ...results.flatMap((result) => [
      `${result.label}: ${(result.ms / 1000).toFixed(2)}s`,
      result.ok ? result.transcript : `ERROR: ${result.error}`,
      "",
    ]),
  ]
    .join("\n")
    .trim();
  await safe("reply (stt benchmark)", ctx.reply(body));
}

async function sendAgentPromptToTelegram(bot: Bot, chatId: number, prompt: string, handle: Handler): Promise<void> {
  let sentText = false;
  await handle(chatId, prompt, {
    onAssistantEnd: async (text: string) => {
      for (const part of chunks(text)) {
        const formatted = format(part);
        await bot.api.sendMessage(chatId, formatted.text, {
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
        });
        sentText = true;
      }
    },
    onError: async (text: string) => {
      await bot.api.sendMessage(chatId, `Error: ${text}`);
      sentText = true;
    },
  });
  if (!sentText) throw new Error("agent produced no visible response for internal notification");
}

function startInternalNotificationPump(bot: Bot, handle: Handler): () => void {
  let active = true;
  let processing = false;

  const heartbeat = () => {
    void writeInternalNotificationHeartbeat().catch((err) =>
      log.warn("internal notification heartbeat write failed", err),
    );
  };

  const processOne = async (notification: InternalNotification): Promise<void> => {
    const claimed = await claimInternalNotification(notification);
    if (!claimed) return;
    try {
      await withLock(claimed.chat_id, () =>
        sendAgentPromptToTelegram(bot, claimed.chat_id, renderInternalNotificationPrompt(claimed), handle),
      );
      await finishInternalNotification(claimed, "processed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishInternalNotification(claimed, "failed", message);
      await sendTelegramFallback(
        claimed.chat_id,
        claimed.fallback_text ?? `[${claimed.source}] ${claimed.title}\n\n${claimed.body}`,
      ).catch((fallbackErr) =>
        log.warn("internal notification emergency fallback failed", {
          id: claimed.id,
          err: fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
        }),
      );
    }
  };

  const poll = () => {
    if (processing) return;
    processing = true;
    heartbeat();
    void listPendingInternalNotifications()
      .then(async (notifications) => {
        for (const notification of notifications) {
          if (!active) break;
          await processOne(notification);
        }
      })
      .catch((err) => log.warn("internal notification poll failed", err))
      .finally(() => {
        processing = false;
      });
  };

  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, INTERNAL_NOTIFICATION_HEARTBEAT_MS);
  const pollTimer = setInterval(poll, INTERNAL_NOTIFICATION_POLL_MS);
  poll();
  return () => {
    active = false;
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
  };
}

async function processMessage(ctx: Context, handle: Handler): Promise<void> {
  const chatId = ctx.chat!.id;
  const userText = ctx.message?.text ?? ctx.message?.caption ?? "";

  // ── Slash commands ──────────────────────────────────────────────────────
  // Intercept commands before the agent runs. The registry dispatches to the
  // handler registered for the matching command name (or alias).
  const commandMatch = findCommand(userText);
  if (commandMatch) {
    // Skip bypass-locked commands here; they are handled in the early block
    // of `bot.on("message")` so they can interrupt a long agent run.
    if (!commandMatch.def.bypassLock) {
      await safe(
        `reply (/${commandMatch.def.name})`,
        Promise.resolve(commandMatch.def.handler(ctx, commandMatch.parsed)),
      );
      return;
    }
  }

  const audioCandidate = selectTelegramAudioCandidate(ctx.message);
  let transcribedPrompt: string | undefined;
  if (audioCandidate) {
    const audioStartedAtMs = Date.now();
    try {
      await safe("upload_voice", ctx.replyWithChatAction("upload_voice"));
      if (consumeSttBenchmarkNext(chatId)) {
        await benchmarkTelegramAudio(ctx, audioCandidate, audioStartedAtMs);
        return;
      }
      const transcript = await transcribeTelegramAudio(ctx, audioCandidate);
      transcribedPrompt = formatTranscribedPrompt(audioCandidate, transcript, userText);
    } catch (err) {
      log.warn("telegram audio transcription failed", { chatId, err: err instanceof Error ? err.message : err });
      const message =
        err instanceof MissingLocalWhisperSetupError
          ? err.message
          : `Couldn't transcribe that audio: ${err instanceof Error ? err.message : String(err)}`;
      await safe("reply (audio transcription failed)", ctx.reply(message));
      return;
    }
  }

  let images: ImageContent[] = [];
  try {
    images = await readImages(ctx);
  } catch (err) {
    log.warn("telegram image read failed", { chatId, err: err instanceof Error ? err.message : err });
    await safe(
      "reply (image read failed)",
      ctx.reply(`Couldn't read that image: ${err instanceof Error ? err.message : String(err)}`),
    );
    return;
  }

  if (!userText.trim() && images.length === 0 && !transcribedPrompt) {
    await safe(
      "reply (unsupported message)",
      ctx.reply("I can read text, images, and voice/audio. Whatever that was, Telegram is being coy."),
    );
    return;
  }
  const promptText = transcribedPrompt ?? (userText.trim() || "Describe the attached image(s).");

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

  // Optional progress/status message for /thinking and /verbose. It is one
  // Telegram message, edited in place and deleted after the final answer.
  const runStatusMode = getStatusMode(chatId);
  let statusMessage: { messageId: number; lines: string[]; lastEditAt: number } | undefined;
  let pendingStatusTimer: NodeJS.Timeout | undefined;
  let pendingStatusText = "";
  const startedAt = Date.now();

  const renderStatus = (lines: string[]): string => {
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return [`Working… ${elapsed}s`, "", ...lines.slice(-4)].join("\n");
  };

  const flushStatus = async (text: string): Promise<void> => {
    if (!statusMessage) return;
    await safe("editMessageText (status)", ctx.api.editMessageText(chatId, statusMessage.messageId, text));
    statusMessage.lastEditAt = Date.now();
  };

  const cancelPendingStatus = () => {
    if (pendingStatusTimer) {
      clearTimeout(pendingStatusTimer);
      pendingStatusTimer = undefined;
    }
  };

  const pushStatus = async (text: string): Promise<void> => {
    if (runStatusMode === "off") return;
    const line = `→ ${text}`;

    if (!statusMessage) {
      const sent = await safe("reply (status)", ctx.reply(renderStatus([line])));
      if (sent) {
        statusMessage = { messageId: sent.message_id, lines: [line], lastEditAt: Date.now() };
      }
      return;
    }

    if (statusMessage.lines.at(-1) !== line) statusMessage.lines.push(line);
    const rendered = renderStatus(statusMessage.lines);
    const elapsed = Date.now() - statusMessage.lastEditAt;
    if (elapsed >= STATUS_EDIT_DEBOUNCE_MS) {
      cancelPendingStatus();
      await flushStatus(rendered);
    } else {
      pendingStatusText = rendered;
      if (!pendingStatusTimer) {
        pendingStatusTimer = setTimeout(() => {
          pendingStatusTimer = undefined;
          void flushStatus(pendingStatusText);
        }, STATUS_EDIT_DEBOUNCE_MS - elapsed);
      }
    }
  };

  const clearStatus = async (): Promise<void> => {
    cancelPendingStatus();
    if (!statusMessage) return;
    const id = statusMessage.messageId;
    statusMessage = undefined;
    await safe("deleteMessage (status)", ctx.api.deleteMessage(chatId, id));
  };

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

    if (!sending) {
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
    await handle(
      chatId,
      promptText,
      {
        // Streaming text update for an in-progress text-only assistant message.
        // Either send the placeholder if we don't have one yet, or schedule a
        // debounced edit to the existing one.
        onAssistantUpdate: async (_text: string) => {
          // No-op: we don't stream intermediate text to Telegram. The typing
          // indicator handles the "working…" signal. Only the final message
          // is sent, via onAssistantEnd → sendFinalChunks.
        },

        // The text-only assistant message finished. Final flush, then reset
        // local state so a subsequent message in the same turn (rare with the
        // skip-tool-call rule) starts with a fresh placeholder.
        onAssistantEnd: async (text: string) => {
          cancelPendingEdit();
          await clearStatus();
          await sendFinalChunks(text);
        },

        // A streaming text message just sprouted a tool call — discard our
        // placeholder so the user doesn't see the "let me check…" filler.
        onAbandon: async () => {
          // No placeholder to delete — we never stream intermediate text.
        },

        // The agent terminated this turn with stopReason "error" / "aborted".
        // Without this the user sees nothing — silent failures are the worst
        // kind of failure for a chat bot.
        onError: async (text: string) => {
          cancelPendingEdit();
          await clearStatus();
          const body = text === "Run aborted." ? "Cancelled." : `Error: ${text}`;
          if (placeholder) {
            const id = placeholder.messageId;
            placeholder = undefined;
            await safe("editMessageText (error)", ctx.api.editMessageText(chatId, id, body));
          } else if (!sending) {
            await safe("reply (agent error)", ctx.reply(body));
          }
        },

        onStatus: pushStatus,
        statusMode: runStatusMode,
      },
      images,
    );
  } catch (err) {
    log.error("handler error", { err: err instanceof Error ? err.message : err });
    cancelPendingEdit();
    await clearStatus();
    await safe("reply (error)", ctx.reply("Something went wrong."));
  } finally {
    active = false;
    if (typingTimer) clearInterval(typingTimer);
    cancelPendingEdit();
    cancelPendingStatus();
  }
}

export async function runTelegram(handle: Handler): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Register the command menu so Telegram shows hints when users type `/`.
  // Failure here is non-fatal — the bot still works without menu hints.
  try {
    const menu = botMenuCommands();
    await bot.api.setMyCommands(menu);
    log.info("registered telegram command menu", { count: menu.length });
  } catch (err) {
    log.warn("setMyCommands failed", { err: err instanceof Error ? err.message : err });
  }

  bot.on("message", async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    if (userId === undefined || !isAllowed(userId)) {
      log.warn("dropped non-allowlisted message", { userId, chatId });
      return;
    }
    const text = ctx.message?.text ?? ctx.message?.caption ?? "";
    const imageCount = imageCandidateFileIds(ctx).length;
    const audioKind = selectTelegramAudioCandidate(ctx.message)?.kind;
    log.info("inbound", { chatId, userId, len: text.length, imageCount, audioKind });

    // Control commands (those with `bypassLock: true`) must dispatch before the
    // per-chat lock; otherwise they queue behind the long run they are
    // supposed to manage. Comedy, but not useful comedy.
    const bypassMatch = findCommand(text);
    if (bypassMatch?.def.bypassLock) {
      await safe(`reply (/${bypassMatch.def.name})`, Promise.resolve(bypassMatch.def.handler(ctx, bypassMatch.parsed)));
      return;
    }

    // Per-chat serialization — see DESIGN.md §10.
    await withLock(chatId, () => processMessage(ctx, handle));
  });

  const stopInternalNotificationPump = startInternalNotificationPump(bot, handle);
  const shutdown = (sig: string) => {
    log.info("telegram bot stopping", { sig });
    stopInternalNotificationPump();
    void bot.stop();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  log.info("telegram bot starting (long-poll)");
  try {
    await bot.start();
  } finally {
    stopInternalNotificationPump();
  }
  log.info("telegram bot stopped");
}
