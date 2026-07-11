import { readResponseBodyLimited } from "./telegram-delivery.js";

export interface TelegramFileCandidate {
  fileId: string;
  fileSize?: number;
}

export interface DownloadedTelegramFile {
  bytes: Buffer;
  responseMimeType?: string;
}

interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export async function downloadTelegramFile(
  api: TelegramFileApi,
  botToken: string,
  candidate: TelegramFileCandidate,
  options: { maxBytes: number; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<DownloadedTelegramFile> {
  if (candidate.fileSize !== undefined && candidate.fileSize > options.maxBytes) {
    throw new Error(`file is too large (${candidate.fileSize} bytes; max ${options.maxBytes})`);
  }
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const file = await withTimeout(api.getFile(candidate.fileId), options.timeoutMs, "Telegram getFile");
  if (!file.file_path) throw new Error("Telegram did not return a file path");

  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await (options.fetchImpl ?? fetch)(url, { signal: timeout });
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  return {
    bytes: await readResponseBodyLimited(response, options.maxBytes),
    responseMimeType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase(),
  };
}
