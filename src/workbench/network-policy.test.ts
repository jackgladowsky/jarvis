import assert from "node:assert/strict";
import test from "node:test";
import { isPublicNetworkAddress, WorkbenchNetworkPolicy, type WorkbenchResolver } from "./network-policy.js";

test("address classifier blocks private, metadata, reserved, multicast, and mapped IPv6", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "192.0.2.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  assert.equal(isPublicNetworkAddress("8.8.8.8"), true);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111"), true);
});

test("private hostname and DNS rebinding are blocked with injected resolver", async () => {
  let now = 0;
  let response = "10.0.0.1";
  const resolver: WorkbenchResolver = async () => [{ address: response, family: 4 }];
  const privatePolicy = new WorkbenchNetworkPolicy(resolver, 10, () => now);
  await assert.rejects(() => privatePolicy.assertUrlAllowed("https://private.example"), /non-public/);

  response = "8.8.8.8";
  const rebindingPolicy = new WorkbenchNetworkPolicy(resolver, 10, () => now);
  await rebindingPolicy.assertUrlAllowed("https://rebind.example");
  now = 11;
  response = "127.0.0.1";
  await assert.rejects(() => rebindingPolicy.assertUrlAllowed("https://rebind.example/resource"), /rebinding/);
});

test("pinned redirects strip cross-origin authority and apply Fetch method semantics", async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    if (calls.length === 1)
      return new Response(null, { status: 302, headers: { location: "https://other.example/final" } });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const resolver: WorkbenchResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const policy = new WorkbenchNetworkPolicy(resolver, 1_000, Date.now, fetcher);
  const response = await policy.pinnedFetch("https://first.example/start", {
    method: "POST",
    body: "secret-body",
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "Proxy-Authorization": "Basic secret",
      Origin: "https://first.example",
      Referer: "https://first.example/page",
      "Content-Type": "text/plain",
      "Content-Length": "11",
      "X-Benign": "kept",
    },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(calls[1]?.method, "GET");
  assert.equal(calls[1]?.body, undefined);
  for (const header of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "origin",
    "referer",
    "content-type",
    "content-length",
  ])
    assert.equal(calls[1]?.headers.has(header), false, header);
  assert.equal(calls[1]?.headers.get("x-benign"), "kept");
});

test("pinned responses bound decoded bytes and remove stale compression headers", async () => {
  const resolver: WorkbenchResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const compressedFetcher = (async () =>
    new Response("decoded", {
      headers: { "content-encoding": "gzip", "content-length": "3", "content-type": "text/plain" },
    })) as typeof fetch;
  const compressed = await new WorkbenchNetworkPolicy(resolver, 1_000, Date.now, compressedFetcher).pinnedFetch(
    "https://public.example/data",
  );
  assert.equal(compressed.headers.has("content-encoding"), false);
  assert.equal(compressed.headers.has("content-length"), false);
  assert.equal(await compressed.text(), "decoded");

  const oversizedFetcher = (async () => new Response("x".repeat(32))) as typeof fetch;
  const oversized = await new WorkbenchNetworkPolicy(resolver, 1_000, Date.now, oversizedFetcher).pinnedFetch(
    "https://large.example/data",
    {},
    0,
    16,
  );
  await assert.rejects(() => oversized.arrayBuffer(), /exceeds 16 bytes/);
});

test("route interception blocks redirects, private subresources, cookies, and oversized responses", async () => {
  const resolver: WorkbenchResolver = async (hostname) => [
    { address: hostname === "public.example" ? "8.8.8.8" : "169.254.169.254", family: 4 },
  ];
  const policy = new WorkbenchNetworkPolicy(resolver);
  policy.pinnedFetch = async (url: string) => {
    await policy.assertUrlAllowed(url, true);
    if (url.includes("redirect")) throw new Error("redirects are not allowed");
    if (url.includes("large")) throw new Error("response exceeds byte limit");
    return new Response("ok", { status: 200, headers: { "set-cookie": "secret=1", "x-safe": "yes" } });
  };
  let handler: ((route: any) => Promise<void>) | undefined;
  let websocketBlocked = false;
  await policy.install({
    routeWebSocket: async () => void (websocketBlocked = true),
    route: async (_pattern: string, value: typeof handler) => void (handler = value),
  } as any);
  assert.equal(websocketBlocked, true);
  assert.ok(handler);

  const exercise = async (url: string, navigation: boolean) => {
    let continued = false;
    let aborted = false;
    let fulfilledHeaders: Record<string, string> = {};
    await handler!({
      request: () => ({
        url: () => url,
        isNavigationRequest: () => navigation,
        method: () => "GET",
        headers: () => ({}),
        postDataBuffer: () => null,
      }),
      fulfill: async (options: { headers?: Record<string, string> }) => {
        continued = true;
        fulfilledHeaders = options.headers ?? {};
      },
      abort: async () => void (aborted = true),
    });
    return { continued, aborted, fulfilledHeaders };
  };
  const publicResult = await exercise("https://public.example", true);
  assert.equal(publicResult.continued, true);
  assert.equal(publicResult.aborted, false);
  assert.equal(publicResult.fulfilledHeaders["set-cookie"], undefined);
  assert.equal(publicResult.fulfilledHeaders["x-safe"], "yes");
  assert.equal((await exercise("https://metadata.example/latest", false)).aborted, true);
  assert.equal((await exercise("https://public.example/redirect", true)).aborted, true);
  assert.equal((await exercise("https://public.example/large", false)).aborted, true);
});
