import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mpga",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/x-m4a": "m4a",
  "audio/x-wav": "wav",
};

const AUDIO_EXTENSIONS = new Set(Object.values(AUDIO_EXTENSION_BY_MIME));

export interface TelegramAudioCandidate {
  fileId: string;
  kind: "voice" | "audio" | "document";
  mimeType: string;
  fileName: string;
  fileSize?: number;
}

interface TelegramAudioLikeMessage {
  voice?: {
    file_id: string;
    mime_type?: string;
    file_size?: number;
  };
  audio?: {
    file_id: string;
    mime_type?: string;
    file_name?: string;
    file_size?: number;
  };
  document?: {
    file_id: string;
    mime_type?: string;
    file_name?: string;
    file_size?: number;
  };
}

export class MissingLocalWhisperSetupError extends Error {
  constructor(
    message = "Local speech-to-text is not configured. Set stt.provider to local-whisper-cpp, install whisper.cpp, set the whisper binary/model paths in ~/.jarvis/config.yaml, and restart JARVIS.",
  ) {
    super(message);
    this.name = "MissingLocalWhisperSetupError";
  }
}

export interface LocalWhisperCppOptions {
  provider: "disabled" | "local-whisper-cpp";
  whisperBinaryPath: string;
  modelPath: string;
  ffmpegPath: string | null;
  maxAudioMb: number;
  timeoutSeconds: number;
}

export interface CommandRunner {
  (file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string; stderr: string }>;
}

function extensionFromFileName(fileName: string | undefined): string | undefined {
  const match = fileName?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1];
}

function isAudioDocument(document: NonNullable<TelegramAudioLikeMessage["document"]>): boolean {
  if (document.mime_type?.startsWith("audio/")) return true;
  const ext = extensionFromFileName(document.file_name);
  return ext ? AUDIO_EXTENSIONS.has(ext) : false;
}

function fileNameFor(kind: TelegramAudioCandidate["kind"], mimeType: string, provided?: string): string {
  if (provided?.trim()) return basename(provided.trim());
  const ext = AUDIO_EXTENSION_BY_MIME[mimeType] ?? "ogg";
  return `${kind}.${ext}`;
}

export function selectTelegramAudioCandidate(
  message: TelegramAudioLikeMessage | undefined,
): TelegramAudioCandidate | undefined {
  if (!message) return undefined;

  if (message.voice) {
    const mimeType = message.voice.mime_type ?? "audio/ogg";
    return {
      fileId: message.voice.file_id,
      kind: "voice",
      mimeType,
      fileName: fileNameFor("voice", mimeType),
      fileSize: message.voice.file_size,
    };
  }

  if (message.audio) {
    const mimeType = message.audio.mime_type ?? "audio/mpeg";
    return {
      fileId: message.audio.file_id,
      kind: "audio",
      mimeType,
      fileName: fileNameFor("audio", mimeType, message.audio.file_name),
      fileSize: message.audio.file_size,
    };
  }

  const document = message.document;
  if (document && isAudioDocument(document)) {
    const mimeType = document.mime_type?.startsWith("audio/") ? document.mime_type : "audio/ogg";
    return {
      fileId: document.file_id,
      kind: "document",
      mimeType,
      fileName: fileNameFor("document", mimeType, document.file_name),
      fileSize: document.file_size,
    };
  }

  return undefined;
}

export function maxAudioBytes(maxAudioMb: number): number {
  return maxAudioMb * 1024 * 1024;
}

export function formatTranscribedPrompt(
  candidate: TelegramAudioCandidate,
  transcript: string,
  caption?: string,
): string {
  const label = candidate.kind === "voice" ? "Telegram voice note" : "Telegram audio message";
  const lines = [`[Transcribed ${label}]`, transcript.trim()];
  const trimmedCaption = caption?.trim();
  if (trimmedCaption) lines.push("", "[Caption]", trimmedCaption);
  return lines.join("\n");
}

async function assertReadable(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new MissingLocalWhisperSetupError(`${label} is not readable: ${path}`);
  }
}

async function assertExecutable(path: string, label: string): Promise<void> {
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new MissingLocalWhisperSetupError(`${label} is not executable: ${path}`);
  }
}

function transcriptFromStdout(stdout: string): string | undefined {
  const cleaned = stdout
    .split("\n")
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  return cleaned || undefined;
}

export async function transcribeWithLocalWhisperCpp(
  audio: Buffer,
  candidate: TelegramAudioCandidate,
  options: LocalWhisperCppOptions,
  runner: CommandRunner = (file, args, execOptions) => execFile(file, args, execOptions),
): Promise<string> {
  if (options.provider !== "local-whisper-cpp") throw new MissingLocalWhisperSetupError();

  const limit = maxAudioBytes(options.maxAudioMb);
  if (audio.byteLength > limit) {
    throw new Error(
      `audio is too large (${Math.ceil(audio.byteLength / 1024 / 1024)} MB; max ${options.maxAudioMb} MB)`,
    );
  }

  await assertExecutable(options.whisperBinaryPath, "whisper.cpp binary");
  await assertReadable(options.modelPath, "whisper.cpp model");

  const ext = extensionFromFileName(candidate.fileName) ?? AUDIO_EXTENSION_BY_MIME[candidate.mimeType] ?? "ogg";
  const workDir = await mkdtemp(join(tmpdir(), "jarvis-stt-"));
  try {
    const inputPath = join(workDir, `input.${ext}`);
    await writeFile(inputPath, audio);

    let whisperInputPath = inputPath;
    if (options.ffmpegPath) {
      await assertExecutable(options.ffmpegPath, "ffmpeg binary");
      whisperInputPath = join(workDir, "input.wav");
      await runner(
        options.ffmpegPath,
        ["-nostdin", "-y", "-i", inputPath, "-ar", "16000", "-ac", "1", whisperInputPath],
        {
          timeout: options.timeoutSeconds * 1000,
        },
      );
    } else if (!candidate.mimeType.includes("wav") && ext !== "wav") {
      throw new MissingLocalWhisperSetupError(
        "ffmpeg_path is required to transcribe Telegram voice/audio formats that are not WAV.",
      );
    }

    const outputBase = join(workDir, "transcript");
    const result = await runner(
      options.whisperBinaryPath,
      ["-m", options.modelPath, "-f", whisperInputPath, "-otxt", "-of", outputBase, "-nt"],
      {
        timeout: options.timeoutSeconds * 1000,
      },
    );

    let transcript: string | undefined;
    try {
      transcript = (await readFile(`${outputBase}.txt`, "utf-8")).trim();
    } catch {
      transcript = transcriptFromStdout(result.stdout);
    }

    if (!transcript) throw new Error("whisper.cpp returned no transcript");
    return transcript;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
