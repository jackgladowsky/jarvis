import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTranscribedPrompt,
  MissingLocalWhisperSetupError,
  selectTelegramAudioCandidate,
  transcribeWithLocalWhisperCpp,
  type CommandRunner,
  type LocalWhisperCppOptions,
} from "./audio-transcription.js";

async function baseOptions(): Promise<LocalWhisperCppOptions> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-stt-test-"));
  const modelPath = join(dir, "ggml-base.en.bin");
  await writeFile(modelPath, "not a real model");
  return {
    provider: "local-whisper-cpp",
    whisperBinaryPath: "/bin/echo",
    modelPath,
    ffmpegPath: "/bin/echo",
    maxAudioMb: 10,
    timeoutSeconds: 30,
  };
}

test("selectTelegramAudioCandidate prefers Telegram voice notes", () => {
  const candidate = selectTelegramAudioCandidate({
    voice: { file_id: "voice-file", mime_type: "audio/ogg", file_size: 123 },
    audio: { file_id: "audio-file", mime_type: "audio/mpeg" },
  });

  assert.deepEqual(candidate, {
    fileId: "voice-file",
    kind: "voice",
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
    fileSize: 123,
  });
});

test("selectTelegramAudioCandidate accepts audio documents", () => {
  const candidate = selectTelegramAudioCandidate({
    document: { file_id: "doc-file", mime_type: "audio/webm", file_name: "note.webm" },
  });

  assert.equal(candidate?.kind, "document");
  assert.equal(candidate?.mimeType, "audio/webm");
  assert.equal(candidate?.fileName, "note.webm");
});

test("selectTelegramAudioCandidate ignores non-audio documents", () => {
  assert.equal(selectTelegramAudioCandidate({
    document: { file_id: "doc-file", mime_type: "application/pdf", file_name: "paper.pdf" },
  }), undefined);
});

test("formatTranscribedPrompt prefixes transcript and keeps caption", () => {
  const text = formatTranscribedPrompt({
    fileId: "file",
    kind: "voice",
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
  }, " remind me to buy coffee ", "urgent");

  assert.equal(text, "[Transcribed Telegram voice note]\nremind me to buy coffee\n\n[Caption]\nurgent");
});

test("transcribeWithLocalWhisperCpp runs ffmpeg and whisper with configured paths", async () => {
  const calls: Array<{ file: string; args: string[]; timeout: number }> = [];
  const runner: CommandRunner = async (file, args, options) => {
    calls.push({ file, args, timeout: options.timeout });
    const outputFlagIndex = args.indexOf("-of");
    const outputBase = outputFlagIndex === -1 ? undefined : args[outputFlagIndex + 1];
    if (outputBase) await writeFile(`${outputBase}.txt`, "hello from local whisper\n");
    return { stdout: "", stderr: "" };
  };

  const transcript = await transcribeWithLocalWhisperCpp(Buffer.from("fake audio"), {
    fileId: "file",
    kind: "voice",
    mimeType: "audio/ogg",
    fileName: "voice.ogg",
  }, await baseOptions(), runner);

  assert.equal(transcript, "hello from local whisper");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].file, "/bin/echo");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-nostdin", "-y", "-i", calls[0].args[3]]);
  assert.equal(calls[1].file, "/bin/echo");
  assert.ok(calls[1].args.includes("-m"));
  assert.ok(calls[1].args.includes("-otxt"));
  assert.equal(calls[1].timeout, 30000);
});

test("transcribeWithLocalWhisperCpp fails clearly when provider is disabled", async () => {
  const options = await baseOptions();
  await assert.rejects(
    () => transcribeWithLocalWhisperCpp(Buffer.from("audio"), {
      fileId: "file",
      kind: "voice",
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
    }, { ...options, provider: "disabled" }),
    MissingLocalWhisperSetupError,
  );
});

test("transcribeWithLocalWhisperCpp requires ffmpeg for Telegram ogg voice notes", async () => {
  const options = await baseOptions();
  await assert.rejects(
    () => transcribeWithLocalWhisperCpp(Buffer.from("audio"), {
      fileId: "file",
      kind: "voice",
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
    }, { ...options, ffmpegPath: null }),
    /ffmpeg_path is required/,
  );
});
