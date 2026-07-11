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

import { join } from "node:path";
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { ImageContent } from "@mariozechner/pi-ai";
import { handleMessage } from "../agent/runtime.js";
import type { PreparedArtifact } from "../agent/tools/send-artifact.js";
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
import {
  extractDocument,
  formatDocumentPrompt,
  MAX_DOCUMENT_BYTES,
  storeExtractedDocument,
} from "../lib/document-ingestion.js";
import { markdownToTelegramHtml, splitTelegramMarkdown } from "../lib/format.js";
import {
  claimInternalNotification,
  finishInternalNotification,
  InternalNotificationClaimLostError,
  listPendingInternalNotifications,
  renewInternalNotificationClaim,
  renderInternalNotificationPrompt,
  sendTelegramFallback,
  TelegramPartialDeliveryError,
  writeInternalNotificationHeartbeat,
  type InternalNotification,
} from "../lib/internal-notifications.js";
import { log } from "../lib/logger.js";
import { withLock } from "../lib/mutex.js";
import { downloadTelegramFile } from "../lib/telegram-media.js";
import { withTelegramRetry } from "../lib/telegram-delivery.js";
import { paths } from "../paths.js";
import type { WorkbenchApprovalRecord } from "../workbench/approval.js";
import { enrichTelegramPrompt, replyParametersForMessage } from "./message-context.js";
import "./commands/handlers/index.js";
import { botMenuCommands, findCommand } from "./commands/registry.js";
import { consumeSttBenchmarkNext, getStatusMode } from "./commands/handlers/state.js";
import { dispatchCallback } from "./callbacks/dispatcher.js";
import { setCallbackContext } from "./callbacks/context.js";
import { registerAllCallbacks } from "./callbacks/handlers/index.js";

type Handler = typeof handleMessage;

interface TelegramOptions {
  signal?: AbortSignal;
  /** Runs only after grammY has completed polling initialization. */
  onStarted?: () => void | Promise<void>;
}

// Telegram expires the typing indicator after ~5s; re-fire frequently while
// the request is queued/processing so it stays visible until the final reply lands.
const TYPING_REFIRE_MS = 2500;

// Minimum spacing between consecutive `editMessageText` calls on the same
// placeholder. Telegram's per-chat edit rate limit is ~1/sec; 1.5s gives us
// margin and keeps the UI from stuttering.
const STATUS_EDIT_DEBOUNCE_MS = 2500;
const INTERNAL_NOTIFICATION_POLL_MS = 3000;
const INTERNAL_NOTIFICATION_HEARTBEAT_MS = 5000;
const MAX_TELEGRAM_IMAGES = 4;
const MAX_TELEGRAM_IMAGE_BYTES = 10 * 1024 * 1024;
const TELEGRAM_MEDIA_TIMEOUT_MS = 20_000;

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

export async function deliverTelegramArtifact(
  ctx: Context,
  artifact: PreparedArtifact,
  replyParameters?: ReturnType<typeof replyParametersForMessage>,
): Promise<{ messageId: number }> {
  const sent = await withTelegramRetry(() =>
    ctx.replyWithDocument(new InputFile(artifact.path, artifact.fileName), {
      ...(artifact.caption ? { caption: artifact.caption } : {}),
      ...(replyParameters ? { reply_parameters: { ...replyParameters, allow_sending_without_reply: true } } : {}),
    }),
  );
  return { messageId: sent.message_id };
}

async function replyReliably(
  ctx: Context,
  text: string,
  options: Parameters<Context["reply"]>[1] = {},
  plainText = text,
): Promise<Awaited<ReturnType<Context["reply"]>>> {
  try {
    return await withTelegramRetry(() => ctx.reply(text, options));
  } catch (err) {
    if (!options.parse_mode) throw err;
    log.warn("formatted Telegram reply failed; retrying as plain text", {
      err: err instanceof Error ? err.message : err,
    });
    const { parse_mode: _parseMode, ...plainOptions } = options;
    return withTelegramRetry(() => ctx.reply(plainText, plainOptions));
  }
}

async function sendMessageReliably(
  bot: Bot,
  chatId: number,
  formattedText: string,
  plainText: string,
  options: Parameters<Bot["api"]["sendMessage"]>[2] = {},
): Promise<void> {
  try {
    await withTelegramRetry(() => bot.api.sendMessage(chatId, formattedText, options));
  } catch (err) {
    if (!options.parse_mode) throw err;
    log.warn("formatted Telegram send failed; retrying as plain text", {
      chatId,
      err: err instanceof Error ? err.message : err,
    });
    const { parse_mode: _parseMode, ...plainOptions } = options;
    await withTelegramRetry(() => bot.api.sendMessage(chatId, plainText, plainOptions));
  }
}

function startTypingIndicator(ctx: Context): () => void {
  if (!config.telegram.show_typing) return () => undefined;

  let stopped = false;
  let inFlight = false;
  const fire = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    void safe("typing", ctx.replyWithChatAction("typing")).finally(() => {
      inFlight = false;
    });
  };

  fire();
  const timer = setInterval(fire, TYPING_REFIRE_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
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
  const downloaded = await downloadTelegramFile(ctx.api, env.TELEGRAM_BOT_TOKEN, candidate, {
    maxBytes: MAX_TELEGRAM_IMAGE_BYTES,
    timeoutMs: TELEGRAM_MEDIA_TIMEOUT_MS,
  });
  const mimeType = downloaded.responseMimeType?.startsWith("image/") ? downloaded.responseMimeType : candidate.mimeType;
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Telegram file was not an image (${downloaded.responseMimeType ?? mimeType})`);
  }
  return { type: "image", data: downloaded.bytes.toString("base64"), mimeType };
}

async function readImages(ctx: Context): Promise<ImageContent[]> {
  const candidates = imageCandidateFileIds(ctx);
  if (candidates.length === 0) return [];
  return Promise.all(candidates.map((candidate) => downloadTelegramImage(ctx, candidate)));
}

interface TelegramDocumentCandidate {
  fileId: string;
  fileSize?: number;
  fileName?: string;
  mimeType?: string;
}

export function documentCandidate(ctx: Context): TelegramDocumentCandidate | undefined {
  const document = ctx.message?.document;
  if (!document || document.mime_type?.startsWith("image/") || selectTelegramAudioCandidate(ctx.message)) return;
  return {
    fileId: document.file_id,
    fileSize: document.file_size,
    fileName: document.file_name,
    mimeType: document.mime_type,
  };
}

async function readDocument(ctx: Context, chatId: number): Promise<string | undefined> {
  const candidate = documentCandidate(ctx);
  if (!candidate) return;
  const downloaded = await downloadTelegramFile(ctx.api, env.TELEGRAM_BOT_TOKEN, candidate, {
    maxBytes: MAX_DOCUMENT_BYTES,
    timeoutMs: TELEGRAM_MEDIA_TIMEOUT_MS,
  });
  const extracted = await extractDocument({
    bytes: downloaded.bytes,
    fileName: candidate.fileName,
    declaredMimeType: downloaded.responseMimeType ?? candidate.mimeType,
  });
  const stored = await storeExtractedDocument(
    join(paths.telegramDocuments, String(chatId)),
    {
      bytes: downloaded.bytes,
      fileName: candidate.fileName,
      declaredMimeType: downloaded.responseMimeType ?? candidate.mimeType,
    },
    extracted,
  );
  return formatDocumentPrompt(stored, ctx.message?.caption ?? "");
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
  return (
    await downloadTelegramFile(ctx.api, env.TELEGRAM_BOT_TOKEN, candidate, {
      maxBytes: maxAudioBytes(config.stt.local_whisper_cpp.max_audio_mb),
      timeoutMs: TELEGRAM_MEDIA_TIMEOUT_MS,
    })
  ).bytes;
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
  await replyReliably(ctx, body);
}

async function sendAgentPromptToTelegram(bot: Bot, chatId: number, prompt: string, handle: Handler): Promise<void> {
  let sentText = false;
  try {
    await handle(chatId, prompt, {
      onAssistantEnd: async (text: string) => {
        for (const part of chunks(text)) {
          const formatted = format(part);
          await sendMessageReliably(bot, chatId, formatted.text, part, {
            parse_mode: formatted.parse_mode,
            link_preview_options: { is_disabled: true },
          });
          sentText = true;
        }
      },
      onError: async (text: string) => {
        await sendMessageReliably(bot, chatId, `Error: ${text}`, `Error: ${text}`);
        sentText = true;
      },
    });
  } catch (err) {
    if (!sentText) throw err;
    log.warn("internal notification agent failed after visible delivery; suppressing duplicate fallback", {
      chatId,
      err: err instanceof Error ? err.message : err,
    });
  }
  if (!sentText) throw new Error("agent produced no visible response for internal notification");
}

// Send background task notifications as plain text. Background task action
// buttons were intentionally removed: direct commands are clearer and avoid
// stale inline controls lingering in chat history.
async function sendPlainNotification(bot: Bot, notification: InternalNotification): Promise<void> {
  const text = notification.fallback_text ?? `[${notification.source}] ${notification.title}\n\n${notification.body}`;
  const formatted = format(text);
  await sendMessageReliably(bot, notification.chat_id, formatted.text, text, {
    parse_mode: formatted.parse_mode,
    link_preview_options: { is_disabled: true },
  });
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
    let renewal: Promise<void> | undefined;
    let claimLostError: unknown;
    const renewTimer = setInterval(() => {
      if (renewal) return;
      renewal = renewInternalNotificationClaim(claimed)
        .catch((err) => {
          if (err instanceof InternalNotificationClaimLostError) claimLostError = err;
          log.warn("internal notification claim renewal failed", {
            id: claimed.id,
            err: err instanceof Error ? err.message : err,
          });
        })
        .finally(() => {
          renewal = undefined;
        });
    }, 60_000);
    const stopRenewal = async (): Promise<void> => {
      clearInterval(renewTimer);
      await renewal;
    };
    let delivered = false;
    try {
      if (claimed.source === "background" || claimed.source === "deploy") {
        await sendPlainNotification(bot, claimed);
      } else {
        // Agent delivery is deliberately not promise-raced against a timeout:
        // the underlying run cannot be safely detached/cancelled here, and a
        // fallback racing its later answer would duplicate the notification.
        await withLock(claimed.chat_id, () =>
          sendAgentPromptToTelegram(bot, claimed.chat_id, renderInternalNotificationPrompt(claimed), handle),
        );
      }
      delivered = true;
      await stopRenewal();
      if (claimLostError) throw claimLostError;
      await finishInternalNotification(claimed, "processed");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (delivered) {
        await stopRenewal();
        log.error("internal notification state commit failed after successful delivery; fallback suppressed", {
          id: claimed.id,
          err: message,
        });
        return;
      }
      if (claimLostError || err instanceof InternalNotificationClaimLostError) {
        await stopRenewal();
        log.error("internal notification claim lost before fallback; delivery stopped", {
          id: claimed.id,
          err: message,
        });
        return;
      }
      try {
        await sendTelegramFallback(
          claimed.chat_id,
          claimed.fallback_text ?? `[${claimed.source}] ${claimed.title}\n\n${claimed.body}`,
        );
        await stopRenewal();
        await finishInternalNotification(claimed, "processed");
      } catch (fallbackErr) {
        await stopRenewal();
        await finishInternalNotification(
          claimed,
          fallbackErr instanceof TelegramPartialDeliveryError ? "processed" : "failed",
          fallbackErr instanceof TelegramPartialDeliveryError ? undefined : message,
        );
        log.warn(
          fallbackErr instanceof TelegramPartialDeliveryError
            ? "internal notification fallback was partial; replay suppressed"
            : "internal notification emergency fallback failed; queued for retry",
          {
            id: claimed.id,
            err: fallbackErr instanceof Error ? fallbackErr.message : fallbackErr,
          },
        );
      }
    } finally {
      await stopRenewal();
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

async function processMessage(ctx: Context, handle: Handler, shutdownSignal?: AbortSignal): Promise<void> {
  if (shutdownSignal?.aborted) return;
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
      try {
        await commandMatch.def.handler(ctx, commandMatch.parsed);
      } catch (err) {
        log.error("Telegram command failed", {
          command: commandMatch.def.name,
          chatId,
          err: err instanceof Error ? err.message : err,
        });
        await replyReliably(
          ctx,
          `/${commandMatch.def.name} failed: ${err instanceof Error ? err.message : "unexpected error"}`,
        ).catch((deliveryErr) =>
          log.error("Telegram command failure delivery failed", {
            command: commandMatch.def.name,
            chatId,
            err: deliveryErr instanceof Error ? deliveryErr.message : deliveryErr,
          }),
        );
      }
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
      await replyReliably(ctx, message);
      return;
    }
  }

  let images: ImageContent[] = [];
  try {
    images = await readImages(ctx);
  } catch (err) {
    log.warn("telegram image read failed", { chatId, err: err instanceof Error ? err.message : err });
    await replyReliably(ctx, `Couldn't read that image: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let documentPrompt: string | undefined;
  if (!audioCandidate && images.length === 0 && documentCandidate(ctx)) {
    try {
      await safe("upload_document", ctx.replyWithChatAction("upload_document"));
      documentPrompt = await readDocument(ctx, chatId);
    } catch (err) {
      log.warn("telegram document read failed", { chatId, err: err instanceof Error ? err.message : err });
      await replyReliably(ctx, `Couldn't read that document: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  if (!userText.trim() && images.length === 0 && !transcribedPrompt && !documentPrompt) {
    await replyReliably(
      ctx,
      "I can read text, images, documents, and voice/audio. Whatever that was, Telegram is being coy.",
    );
    return;
  }
  const basePrompt = documentPrompt ?? transcribedPrompt ?? (userText.trim() || "Describe the attached image(s).");
  // Command dispatch above intentionally examines only `userText`. Quoted and
  // forwarded slash-prefixed content is reference data and can never dispatch.
  const promptText = enrichTelegramPrompt(ctx.message, basePrompt).prompt;
  const inboundReplyParameters = replyParametersForMessage(ctx.message);
  let firstAgentReply = true;
  let visibleResponseDelivered = false;

  // ── Streaming placeholder state ─────────────────────────────────────────
  // `placeholder` is undefined until we send the first reply for the current
  // assistant message. After that, subsequent text updates are folded into
  // edits to the same Telegram message id.
  let placeholder: { messageId: number; lastSentText: string; lastEditAt: number } | undefined;
  // Set true while a `ctx.reply` is mid-flight so concurrent updates don't
  // race to send a second placeholder. Belt-and-suspenders alongside the
  // listener-await ordering in runtime.ts.
  const sending = false;
  // Pending debounced edit. Cleared when we flush early or finalize.
  let pendingEditTimer: NodeJS.Timeout | undefined;

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
      if (sent) statusMessage = { messageId: sent.message_id, lines: [line], lastEditAt: Date.now() };
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

  const showStoppedStatus = async (text: string): Promise<void> => {
    cancelPendingStatus();
    cancelPendingEdit();

    if (statusMessage) {
      const id = statusMessage.messageId;
      statusMessage = undefined;
      await withTelegramRetry(() => ctx.api.editMessageText(chatId, id, text));
      visibleResponseDelivered = true;
      return;
    }

    if (!sending) {
      await replyReliably(ctx, text);
      visibleResponseDelivered = true;
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
      await replyReliably(
        ctx,
        formatted.text,
        {
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
          ...(firstAgentReply && inboundReplyParameters
            ? { reply_parameters: { ...inboundReplyParameters, allow_sending_without_reply: true } }
            : {}),
        },
        first,
      );
      firstAgentReply = false;
      visibleResponseDelivered = true;
    }

    for (const part of rest) {
      const formatted = format(part);
      await replyReliably(
        ctx,
        formatted.text,
        {
          parse_mode: formatted.parse_mode,
          link_preview_options: { is_disabled: true },
        },
        part,
      );
      visibleResponseDelivered = true;
    }
  };

  if (shutdownSignal?.aborted) {
    cancelPendingEdit();
    cancelPendingStatus();
    return;
  }

  // ── Run the agent with streaming callbacks ──────────────────────────────
  try {
    await handle(
      chatId,
      promptText,
      {
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
            await withTelegramRetry(() => ctx.api.editMessageText(chatId, id, body));
            visibleResponseDelivered = true;
          } else if (!sending) {
            await replyReliably(ctx, body);
            visibleResponseDelivered = true;
          }
        },

        onCancelled: showStoppedStatus,

        onStatus: pushStatus,
        statusMode: runStatusMode,
      },
      images,
      {
        browserAuthority: {
          chatId,
          userId: ctx.from!.id,
          requestApproval: async (record: WorkbenchApprovalRecord) => {
            const keyboard = new InlineKeyboard()
              .text("Approve once", `wbap:a:${record.id}`)
              .text("Deny", `wbap:d:${record.id}`);
            await replyReliably(ctx, `Browser approval requested (expires in 10 minutes):\n\n${record.planSummary}`, {
              reply_markup: keyboard,
            });
          },
        },
        sendArtifact: async (artifact) => {
          await clearStatus();
          const receipt = await deliverTelegramArtifact(
            ctx,
            artifact,
            firstAgentReply ? inboundReplyParameters : undefined,
          );
          firstAgentReply = false;
          visibleResponseDelivered = true;
          return receipt;
        },
      },
    );
  } catch (err) {
    log.error("handler error", { err: err instanceof Error ? err.message : err });
    cancelPendingEdit();
    await clearStatus();
    if (!visibleResponseDelivered) {
      await replyReliably(ctx, "Something went wrong.").catch((deliveryErr) =>
        log.error("final Telegram error delivery failed", {
          chatId,
          err: deliveryErr instanceof Error ? deliveryErr.message : deliveryErr,
        }),
      );
    }
  } finally {
    cancelPendingEdit();
    cancelPendingStatus();
  }
}

export async function runTelegram(handle: Handler, options: TelegramOptions = {}): Promise<void> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  let stopping = false;
  let botStarted = false;
  let stopInternalNotificationPump: () => void = () => undefined;

  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info("telegram bot stopping", { sig });
    stopInternalNotificationPump();
    if (botStarted) void bot.stop();
  };
  const abortListener = () => shutdown("abort");
  if (options.signal?.aborted) shutdown("abort");
  else options.signal?.addEventListener("abort", abortListener, { once: true });

  if (stopping || options.signal?.aborted) {
    options.signal?.removeEventListener("abort", abortListener);
    return;
  }

  // Register the command menu so Telegram shows hints when users type `/`.
  // Failure here is non-fatal — the bot still works without menu hints.
  try {
    const menu = botMenuCommands();
    await bot.api.setMyCommands(menu);
    log.info("registered telegram command menu", { count: menu.length });
  } catch (err) {
    log.warn("setMyCommands failed", { err: err instanceof Error ? err.message : err });
  }

  // Set the Telegram menu button (next to text input) to open the commands list.
  try {
    await bot.api.setChatMenuButton({
      menu_button: { type: "commands" },
    });
    log.info("set telegram menu button to commands list");
  } catch (err) {
    log.warn("setChatMenuButton failed", { err: err instanceof Error ? err.message : err });
  }

  // Initialize the callback query system: set the context (bot + handle)
  // and register all callback handlers with the dispatcher.
  setCallbackContext({ bot, handle });
  registerAllCallbacks();

  // Catch-all callback query handler — routes to the dispatcher which
  // matches against registered prefixes.
  bot.on("callback_query:data", async (ctx) => {
    if (stopping || options.signal?.aborted) return;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (userId === undefined || !isAllowed(userId)) {
      log.warn("dropped non-allowlisted callback query", { userId, chatId, data: ctx.callbackQuery.data });
      await ctx.answerCallbackQuery({ text: "Not allowed." }).catch(() => undefined);
      return;
    }
    await dispatchCallback(ctx);
  });

  if (stopping || options.signal?.aborted) {
    options.signal?.removeEventListener("abort", abortListener);
    return;
  }

  bot.on("message", async (ctx) => {
    if (stopping || options.signal?.aborted) return;
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
      try {
        await bypassMatch.def.handler(ctx, bypassMatch.parsed);
      } catch (err) {
        log.error("Telegram control command failed", {
          command: bypassMatch.def.name,
          chatId,
          err: err instanceof Error ? err.message : err,
        });
        await replyReliably(
          ctx,
          `/${bypassMatch.def.name} failed: ${err instanceof Error ? err.message : "unexpected error"}`,
        ).catch((deliveryErr) =>
          log.error("Telegram command failure delivery failed", {
            command: bypassMatch.def.name,
            chatId,
            err: deliveryErr instanceof Error ? deliveryErr.message : deliveryErr,
          }),
        );
      }
      return;
    }

    // Per-chat serialization — see DESIGN.md §10. Keep Telegram's native
    // typing state alive while the message is queued and until the reply sends.
    const stopTyping = startTypingIndicator(ctx);
    try {
      await withLock(chatId, () => processMessage(ctx, handle, options.signal));
    } finally {
      stopTyping();
    }
  });

  stopInternalNotificationPump = startInternalNotificationPump(bot, handle);
  if (stopping || options.signal?.aborted) {
    stopInternalNotificationPump();
    options.signal?.removeEventListener("abort", abortListener);
    return;
  }

  log.info("telegram bot starting (long-poll)");
  botStarted = true;
  try {
    if (stopping || options.signal?.aborted) return;
    await bot.start({
      onStart: async () => {
        log.info("telegram bot polling ready");
        await Promise.resolve(options.onStarted?.()).catch((err) =>
          log.warn("Telegram readiness callback failed", { err: err instanceof Error ? err.message : err }),
        );
      },
    });
  } finally {
    botStarted = false;
    stopInternalNotificationPump();
    options.signal?.removeEventListener("abort", abortListener);
  }
  log.info("telegram bot stopped");
}
