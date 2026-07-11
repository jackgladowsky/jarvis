import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { auditToolCall, log } from "../../lib/logger.js";
import { paths } from "../../paths.js";

export const MAX_TELEGRAM_ARTIFACT_BYTES = 49 * 1024 * 1024;
export const MAX_TELEGRAM_CAPTION_LENGTH = 1024;

const schema = Type.Object({
  path: Type.String({
    description:
      "Absolute or working-directory-relative path to a local regular file. Never pass a URL. Generated files should normally be written under ~/.jarvis/data/outbound/ first.",
  }),
  caption: Type.Optional(Type.String({ description: "Optional short Telegram caption.", maxLength: 1024 })),
});

export interface PreparedArtifact {
  path: string;
  fileName: string;
  size: number;
  mimeType: string;
  caption?: string;
  /** Run-scoped descriptor stream; transport must prefer this over reopening path. */
  stream?: Readable;
  /** Validation identity used to fence path replacement before descriptor open. */
  identity?: { dev: number; ino: number };
}

export interface ArtifactDeliveryReceipt {
  messageId: number;
}

export type ArtifactSender = (artifact: PreparedArtifact) => Promise<ArtifactDeliveryReceipt>;

type AuditWriter = typeof auditToolCall;

export interface SendArtifactToolOptions {
  send: ArtifactSender;
  /** Persist the chat replay/visible-side-effect boundary before starting upload. */
  beforeDelivery: () => Promise<void>;
  allowedRoots?: string[];
  blockedRoots?: string[];
  blockedFiles?: string[];
  maxBytes?: number;
  audit?: AuditWriter;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".tar": "application/x-tar",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function canonicalRoot(root: string): Promise<string> {
  return realpath(resolve(root)).catch(() => resolve(root));
}

function defaultAllowedRoots(): string[] {
  return [
    paths.repo,
    paths.outboundArtifacts,
    paths.workbenchScreenshots,
    paths.workbenchArtifacts,
    paths.workbenchDownloads,
    paths.telegramDocuments,
    tmpdir(),
  ];
}

function defaultBlockedRoots(): string[] {
  return [
    join(paths.repo, ".git"),
    join(paths.repo, ".jarvis-dev"),
    join(paths.repo, "node_modules"),
    paths.sessions,
    paths.scheduledJobSessions,
    paths.backgroundSessions,
    paths.backgroundMail,
    paths.backgroundTasks,
    paths.internalNotifications,
  ];
}

function defaultBlockedFiles(): string[] {
  return [
    paths.env,
    paths.configYaml,
    paths.runtimeModel,
    paths.agentsMd,
    paths.systemPrompt,
    paths.adaptiveVoicePrompt,
    paths.audit,
    join(paths.data, ".codex-creds.json"),
    join(paths.data, "mcp-servers.json"),
  ];
}

function secretLikeName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower === "id_ecdsa" ||
    lower === "id_dsa" ||
    lower === ".netrc" ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".git-credentials" ||
    /^(?:credentials|secrets?|tokens?|oauth)\.(?:json|ya?ml)$/.test(lower) ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx")
  );
}

function safeFileName(filePath: string): string {
  const raw = basename(filePath).normalize("NFKC");
  const cleaned = raw
    .replace(/[^A-Za-z0-9._ ()-]/g, "_")
    .replace(/^\.+$/, "file")
    .slice(0, 180);
  return cleaned || "file";
}

function clippedCaption(caption: string | undefined): string | undefined {
  if (caption === undefined) return undefined;
  const value = Array.from(caption.trim()).slice(0, MAX_TELEGRAM_CAPTION_LENGTH).join("");
  return value || undefined;
}

function mimeTypeFor(filePath: string): string {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export async function prepareArtifact(
  inputPath: string,
  caption?: string,
  options: Pick<SendArtifactToolOptions, "allowedRoots" | "blockedRoots" | "blockedFiles" | "maxBytes"> = {},
): Promise<PreparedArtifact> {
  if (!inputPath.trim()) throw new Error("Artifact path must be non-empty.");
  if (/^https?:\/\//i.test(inputPath.trim())) throw new Error("Artifact path must be local, not a URL.");

  const requestedPath = resolve(inputPath.trim());
  const requestedStat = await lstat(requestedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Artifact file does not exist.");
    throw error;
  });
  if (requestedStat.isSymbolicLink()) throw new Error("Refusing to send a symbolic link.");
  if (!requestedStat.isFile()) throw new Error("Artifact must be a regular file, not a directory or device.");

  const canonicalPath = await realpath(requestedPath);
  const allowedRoots = await Promise.all((options.allowedRoots ?? defaultAllowedRoots()).map(canonicalRoot));
  if (!allowedRoots.some((root) => isWithin(root, canonicalPath))) {
    throw new Error("Artifact is outside the approved outbound, workbench, repository, and temporary roots.");
  }

  const blockedRoots = await Promise.all((options.blockedRoots ?? defaultBlockedRoots()).map(canonicalRoot));
  if (blockedRoots.some((root) => isWithin(root, canonicalPath))) {
    throw new Error("Artifact is inside a protected JARVIS state or dependency directory.");
  }
  const blockedFiles = new Set(await Promise.all((options.blockedFiles ?? defaultBlockedFiles()).map(canonicalRoot)));
  if (blockedFiles.has(canonicalPath) || secretLikeName(basename(canonicalPath))) {
    throw new Error("Refusing to send a known secret or sensitive host file.");
  }

  const size = requestedStat.size;
  const maxBytes = options.maxBytes ?? MAX_TELEGRAM_ARTIFACT_BYTES;
  if (size > maxBytes) throw new Error(`Artifact is too large (${size} bytes; max ${maxBytes}).`);

  return {
    path: canonicalPath,
    fileName: safeFileName(canonicalPath),
    size,
    mimeType: mimeTypeFor(canonicalPath),
    caption: clippedCaption(caption),
    identity: { dev: requestedStat.dev, ino: requestedStat.ino },
  };
}

export function createSendArtifactTool(options: SendArtifactToolOptions): AgentTool<typeof schema> {
  const delivered = new Set<string>();
  const audit = options.audit ?? auditToolCall;
  const writeAudit: AuditWriter = async (entry) => {
    try {
      await audit(entry);
    } catch (error) {
      log.error("send_artifact audit writer failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    name: "send_artifact",
    label: "send_artifact",
    description:
      "Send one safe local file to the current Telegram chat. This run-scoped tool has no chat-id or URL argument. Use it when the owner asks for a generated report, patch, archive, browser screenshot, or other local artifact. Write generated files under ~/.jarvis/data/outbound/ when practical. Never use bash/curl to upload Telegram files.",
    parameters: schema,
    async execute(_id, args: Static<typeof schema>) {
      const startedAt = Date.now();
      let prepared: PreparedArtifact | undefined;
      try {
        prepared = await prepareArtifact(args.path, args.caption, options);
        if (delivered.has(prepared.path))
          throw new Error("This artifact was already delivered during the current turn.");

        let handle: FileHandle | undefined;
        try {
          handle = await open(prepared.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.dev !== prepared.identity?.dev ||
            stat.ino !== prepared.identity?.ino ||
            stat.size !== prepared.size
          ) {
            throw new Error("Artifact changed after validation; delivery refused.");
          }
          prepared.stream = handle.createReadStream({ autoClose: false });
          // This durable write must finish before Telegram sees any bytes. If it
          // fails, delivery is refused rather than leaving an unrecorded side effect.
          await options.beforeDelivery();
          const receipt = await options.send(prepared);
          delivered.add(prepared.path);
          await writeAudit({
            tool: "send_artifact",
            args: {
              path: prepared.path,
              size: prepared.size,
              mime_type: prepared.mimeType,
              has_caption: Boolean(prepared.caption),
            },
            outcome: "ok",
            duration_ms: Date.now() - startedAt,
            bytes: prepared.size,
          });
          const details = {
            messageId: receipt.messageId,
            fileName: prepared.fileName,
            size: prepared.size,
            mimeType: prepared.mimeType,
          };
          return { content: [{ type: "text", text: `Artifact delivered: ${JSON.stringify(details)}` }], details };
        } finally {
          prepared.stream?.destroy();
          await handle?.close().catch(() => undefined);
        }
      } catch (error) {
        await writeAudit({
          tool: "send_artifact",
          args: {
            path: prepared?.path ?? resolve(args.path || "."),
            size: prepared?.size,
            mime_type: prepared?.mimeType,
            has_caption: Boolean(args.caption),
          },
          outcome: "error",
          duration_ms: Date.now() - startedAt,
          ...(prepared ? { bytes: prepared.size } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
