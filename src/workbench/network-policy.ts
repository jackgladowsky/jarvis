import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { BrowserContext, Route } from "playwright";
import { Agent } from "undici";
import { validateWorkbenchUrl } from "./safety.js";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type WorkbenchResolver = (hostname: string) => Promise<ResolvedAddress[]>;

interface CacheEntry {
  addresses: string[];
  expiresAt: number;
}

const DEFAULT_DNS_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 256;
export const MAX_PINNED_RESPONSE_BYTES = 8 * 1024 * 1024;
const CROSS_ORIGIN_HEADERS = ["authorization", "cookie", "proxy-authorization", "origin", "referer"];
const ENTITY_HEADERS = ["content-length", "content-type", "content-encoding", "transfer-encoding"];

function redirectedRequestInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  if (from.origin !== to.origin) for (const name of CROSS_ORIGIN_HEADERS) headers.delete(name);
  const method = (init.method ?? "GET").toUpperCase();
  const rewrite = status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST";
  if (rewrite) {
    for (const name of ENTITY_HEADERS) headers.delete(name);
    return { ...init, method: "GET", body: undefined, headers };
  }
  return { ...init, headers };
}

function responseHeaders(headers: Headers): Headers {
  const safe = new Headers(headers);
  // Node fetch transparently decodes transfer/content encodings. Forwarding the
  // original encoding or compressed length would make the fulfilled response malformed.
  safe.delete("content-encoding");
  safe.delete("content-length");
  safe.delete("transfer-encoding");
  return safe;
}

function ipv4Number(value: string): number | undefined {
  if (isIP(value) !== 4) return;
  return value.split(".").reduce((total, octet) => total * 256 + Number(octet), 0) >>> 0;
}

function ipv6Number(value: string): bigint | undefined {
  let input = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  if (isIP(input) !== 6) return;
  const mapped = input.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = ipv4Number(mapped[2]);
    if (v4 === undefined) return;
    input = `${mapped[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const sides = input.split("::");
  if (sides.length > 2) return;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const zeros = sides.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  if (parts.length !== 8) return;
  return parts.reduce((total, part) => (total << 16n) | BigInt(`0x${part || "0"}`), 0n);
}

function inV4(value: number, base: string, bits: number): boolean {
  const start = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (start & mask);
}

export function isPublicNetworkAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== undefined) {
    return ![
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inV4(v4, base as string, bits as number));
  }

  const v6 = ipv6Number(address);
  if (v6 === undefined) return false;
  // IPv4-mapped IPv6 (::ffff:0:0/96) is classified by the embedded IPv4 address.
  if (v6 >> 32n === 0xffffn) {
    const embedded = Number(v6 & 0xffffffffn);
    return isPublicNetworkAddress(
      [embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join("."),
    );
  }
  // Only globally-routable 2000::/3 is allowed, excluding documentation space.
  const global = v6 >= 0x20000000000000000000000000000000n && v6 <= 0x3fffffffffffffffffffffffffffffffn;
  const documentation = v6 >= 0x20010db8000000000000000000000000n && v6 <= 0x20010db8ffffffffffffffffffffffffn;
  return global && !documentation;
}

export class WorkbenchNetworkPolicy {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly resolver: WorkbenchResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
    private readonly ttlMs = DEFAULT_DNS_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async resolveUrl(input: string, forceRevalidate = false): Promise<ResolvedAddress[]> {
    if (
      input === "about:blank" ||
      input.startsWith("about:blank#") ||
      input.startsWith("data:") ||
      input.startsWith("blob:")
    )
      return [];
    const validated = validateWorkbenchUrl(input);
    if (!validated.allowed || !validated.url) throw new Error(validated.reason ?? "URL is blocked.");
    const hostname = validated.url.hostname.replace(/^\[(.*)\]$/, "$1");
    const directIp = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : undefined;
    const prior = this.cache.get(hostname);
    let addresses: ResolvedAddress[];
    if (!forceRevalidate && prior && prior.expiresAt > this.now()) {
      addresses = prior.addresses.map((address) => ({ address, family: isIP(address) }));
    } else {
      addresses = directIp ?? (await this.resolver(hostname));
      if (addresses.length === 0) throw new Error(`Network blocked: ${hostname} did not resolve.`);
      const normalized = [...new Set(addresses.map(({ address }) => address.toLowerCase()))].sort();
      if (prior && prior.addresses.join(",") !== normalized.join(",")) {
        throw new Error(`Network blocked: DNS rebinding detected for ${hostname}.`);
      }
      if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(hostname))
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(hostname, { addresses: normalized, expiresAt: this.now() + this.ttlMs });
    }
    const blocked = addresses.find(({ address }) => !isPublicNetworkAddress(address));
    if (blocked) throw new Error(`Network blocked: ${hostname} resolved to non-public address ${blocked.address}.`);
    return addresses;
  }

  async assertUrlAllowed(input: string, forceRevalidate = false): Promise<void> {
    await this.resolveUrl(input, forceRevalidate);
  }

  /** Fetch through an address pinned to the validated DNS result while retaining the URL hostname for TLS SNI. */
  async pinnedFetch(
    input: string,
    init: RequestInit = {},
    redirects = 5,
    maxBytes = MAX_PINNED_RESPONSE_BYTES,
  ): Promise<Response> {
    let url = new URL(input);
    let requestInit = { ...init };
    for (let hop = 0; hop <= redirects; hop += 1) {
      const addresses = await this.resolveUrl(url.toString(), true);
      if (addresses.length === 0) return this.fetcher(url, requestInit);
      const allowed = new Set(addresses.map(({ address }) => address));
      const dispatcher = new Agent({
        connect: {
          lookup: (_hostname, options, callback) => {
            const family = typeof options === "object" && options ? options.family : undefined;
            const chosen = addresses.find((entry) => !family || entry.family === family) ?? addresses[0]!;
            if (!allowed.has(chosen.address)) return callback(new Error("DNS pinning failed"), "", 0);
            callback(null, chosen.address, chosen.family);
          },
        },
      });
      try {
        const response = await this.fetcher(url, {
          ...requestInit,
          redirect: "manual",
          dispatcher,
        } as unknown as RequestInit);
        const redirect = [301, 302, 303, 307, 308].includes(response.status);
        const location = redirect ? response.headers.get("location") : undefined;
        if (redirect && location) {
          await response.body?.cancel();
          await dispatcher.close();
          if (hop === redirects) throw new Error("Network blocked: redirects are not allowed for this request.");
          const nextUrl = new URL(location, url);
          requestInit = redirectedRequestInit(requestInit, response.status, url, nextUrl);
          url = nextUrl;
          continue;
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await response.body?.cancel();
          throw new Error(`Network blocked: response exceeds ${maxBytes} bytes.`);
        }
        if (!response.body) {
          await dispatcher.close();
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response.headers),
          });
        }
        const reader = response.body.getReader();
        let closed = false;
        let received = 0;
        const close = async () => {
          if (closed) return;
          closed = true;
          await dispatcher.close();
        };
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                await close();
              } else {
                received += chunk.value.byteLength;
                if (received > maxBytes) {
                  await reader.cancel("response limit exceeded");
                  controller.error(new Error(`Network blocked: response exceeds ${maxBytes} bytes.`));
                  await close();
                } else controller.enqueue(chunk.value);
              }
            } catch (error) {
              controller.error(error);
              await close();
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            await close();
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders(response.headers),
        });
      } catch (error) {
        await dispatcher.close().catch(() => undefined);
        throw error;
      }
    }
    throw new Error("Network blocked: redirect limit exceeded.");
  }

  async install(context: BrowserContext): Promise<void> {
    // WebSockets cannot use the pinned HTTP dispatcher, so fail closed by mocking them without a server connection.
    await context.routeWebSocket("**/*", () => undefined);
    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      try {
        const response = await this.pinnedFetch(
          request.url(),
          {
            method: request.method(),
            headers: request.headers(),
            body: request.method() === "GET" || request.method() === "HEAD" ? undefined : request.postDataBuffer(),
          },
          0,
          MAX_PINNED_RESPONSE_BYTES,
        );
        const body = Buffer.from(await response.arrayBuffer());
        const headers = new Headers(response.headers);
        // The proxy is deliberately stateless: browser redirects and server-set
        // cookies are blocked rather than pretending Playwright's fulfill path
        // has transparent network-stack semantics.
        headers.delete("set-cookie");
        headers.delete("set-cookie2");
        await route.fulfill({ status: response.status, headers: Object.fromEntries(headers), body });
      } catch {
        await route.abort("blockedbyclient");
      }
    });
  }
}
