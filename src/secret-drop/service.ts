import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { URLSearchParams } from "node:url";
import { atomicWriteFile, appendFileDurable, withFileLock } from "../lib/durable-file.js";
import { enqueueInternalNotification } from "../lib/internal-notifications.js";
import { paths } from "../paths.js";
import { config } from "../config.js";

const KEY = "KERNEL_API_KEY" as const;
const MAX_BODY_BYTES = 8192;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;

type Drop = {
  id: string;
  tokenHash: Buffer;
  csrfHash?: Buffer;
  key: typeof KEY;
  chatId: number;
  expiresAt: number;
  used: boolean;
};
export interface SecretDropOptions {
  publicBaseUrl: string;
  port: number;
  envPath: string;
  auditPath: string;
  notify?: (chatId: number, text: string) => Promise<void>;
  now?: () => number;
}
export interface CreatedDrop {
  url: string;
  expiresAt: string;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
function origin(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error(
      "secret_drop.public_base_url must be an HTTPS origin without path, query, fragment, or credentials",
    );
  return url;
}
function headers(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
}
function generic(res: ServerResponse, code = 404, body = "Not found"): void {
  headers(res);
  res.statusCode = code;
  res.end(body);
}
// This is deliberately a raw, unquoted EnvironmentFile token grammar. Do
// not loosen it without implementing and testing systemd's quoting semantics.
const SAFE_KERNEL_KEY = /^[A-Za-z0-9._~+/:=@-]{1,4096}$/;
function validSecret(value: string): boolean {
  return SAFE_KERNEL_KEY.test(value);
}

export class SecretDropService {
  private readonly base: URL;
  private readonly drops = new Map<string, Drop>();
  private readonly rate = new Map<string, number[]>();
  private server?: Server;
  private cleanupTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  constructor(private readonly options: SecretDropOptions) {
    this.base = origin(options.publicBaseUrl);
    this.now = options.now ?? Date.now;
  }
  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.port, "127.0.0.1", () => {
        this.server!.off("error", reject);
        this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
        this.cleanupTimer.unref();
        resolve();
      });
    });
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
  async create(key: string, minutes: number, chatId: number): Promise<CreatedDrop> {
    if (key !== KEY) throw new Error("Secret key is not allowlisted");
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 10) throw new Error("Expiry must be 5-10 minutes");
    this.cleanup();
    const token = randomBytes(32).toString("base64url");
    const id = randomBytes(12).toString("hex");
    const expiresAt = this.now() + minutes * 60_000;
    this.drops.set(id, { id, tokenHash: digest(token), key: KEY, chatId, expiresAt, used: false });
    await this.audit("created", { key: KEY, ttl_minutes: minutes, id });
    return {
      url: new URL(`/secret-drop/${id}.${token}`, this.base).toString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  private cleanup(): void {
    const now = this.now();
    for (const [id, drop] of this.drops)
      if (drop.expiresAt <= now) {
        this.drops.delete(id);
        void this.audit("expired", { key: drop.key, id }).catch(() => undefined);
        void this.notify(drop.chatId, "Secret submission link expired.").catch(() => undefined);
      }
  }
  private async notify(chatId: number, text: string): Promise<void> {
    if (this.options.notify) return this.options.notify(chatId, text);
    await enqueueInternalNotification({
      source: "system",
      chat_id: chatId,
      title: "Secret drop",
      body: text,
      fallback_text: text,
      delivery: "plain",
    });
  }
  private async audit(event: string, fields: Record<string, unknown>): Promise<void> {
    await appendFileDurable(
      this.options.auditPath,
      JSON.stringify({ ts: new Date(this.now()).toISOString(), event, ...fields }) + "\n",
    );
  }
  private lookup(raw: string): Drop | undefined {
    const match = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(raw);
    if (!match) return;
    const drop = this.drops.get(match[1]);
    if (!drop || drop.used || drop.expiresAt <= this.now() || !safeEqual(drop.tokenHash, digest(match[2]))) return;
    return drop;
  }
  private hostOk(req: IncomingMessage): boolean {
    return req.headers.host === this.base.host;
  }
  private limited(req: IncomingMessage): boolean {
    const ip = req.socket.remoteAddress ?? "unknown";
    const now = this.now();
    const values = (this.rate.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    values.push(now);
    this.rate.set(ip, values);
    return values.length > RATE_LIMIT;
  }
  private async body(req: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString("utf8") : undefined));
      req.on("error", () => resolve(undefined));
    });
  }
  private async updateEnv(value: string): Promise<void> {
    await withFileLock(this.options.envPath, async () => {
      try {
        if ((await lstat(this.options.envPath)).isSymbolicLink()) throw new Error("refusing symlink env file");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const raw = await readFile(this.options.envPath, "utf8").catch((e: NodeJS.ErrnoException) =>
        e.code === "ENOENT" ? "" : Promise.reject(e),
      );
      const line = `${KEY}=${value}`;
      const re = new RegExp(`^${KEY}=.*$`, "m");
      const next = re.test(raw) ? raw.replace(re, line) : `${raw}${raw && !raw.endsWith("\n") ? "\n" : ""}${line}\n`;
      await atomicWriteFile(this.options.envPath, next, { mode: 0o600 });
    });
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.cleanup();
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (requestUrl.search) return generic(res);
    const match = /^\/secret-drop\/([^/]+)$/.exec(requestUrl.pathname);
    if (!match || !this.hostOk(req)) return generic(res);
    const drop = this.lookup(match[1]);
    if (!drop) return generic(res);
    if (req.method === "GET") {
      const csrf = randomBytes(32).toString("base64url");
      drop.csrfHash = digest(csrf);
      headers(res);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return void res.end(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>Secret submission</title><form method="post"><input type="hidden" name="csrf" value="${csrf}"><label>Secret <input name="secret" type="password" autocomplete="off" required></label><button>Submit</button></form>`,
      );
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== this.base.origin ||
      !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ||
      this.limited(req)
    )
      return generic(res);
    const raw = await this.body(req);
    if (!raw) return generic(res, 400, "Submission was not accepted.");
    const form = new URLSearchParams(raw);
    const csrf = form.get("csrf") ?? "";
    const value = form.get("secret") ?? "";
    if (!drop.csrfHash || !safeEqual(drop.csrfHash, digest(csrf)) || !validSecret(value)) {
      await this.audit("rejected", { key: drop.key, id: drop.id });
      return generic(res, 400, "Submission was not accepted.");
    }
    // `lookup` happened before body parsing awaited. Re-check and claim here,
    // synchronously, so two completed request bodies cannot both persist.
    if (drop.used) return generic(res, 400, "Submission was not accepted.");
    drop.used = true;
    this.drops.delete(drop.id);
    try {
      await this.updateEnv(value);
      await this.audit("stored", { key: drop.key, id: drop.id });
      await this.notify(drop.chatId, "Secret stored. Restart JARVIS when you want it loaded.");
      headers(res);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Submitted</title><p>Submission received.</p>");
    } catch {
      await this.audit("failed", { key: drop.key, id: drop.id });
      generic(res, 500, "Submission was not accepted.");
    }
  }
}

let active: SecretDropService | undefined;
export async function startSecretDropService(): Promise<() => Promise<void>> {
  if (!config.secret_drop.enabled) return async () => undefined;
  active = new SecretDropService({
    publicBaseUrl: config.secret_drop.public_base_url,
    port: config.secret_drop.port,
    envPath: paths.env,
    auditPath: paths.secretDropAudit,
  });
  await active.start();
  return async () => {
    await active?.stop();
    active = undefined;
  };
}
export function createSecretDrop(key: string, minutes: number, chatId: number): Promise<CreatedDrop> {
  if (!active) throw new Error("Secret drop is not enabled");
  return active.create(key, minutes, chatId);
}
