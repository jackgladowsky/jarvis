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

test("route interception blocks private redirects and subresources", async () => {
  const resolver: WorkbenchResolver = async (hostname) => [
    { address: hostname === "public.example" ? "8.8.8.8" : "169.254.169.254", family: 4 },
  ];
  const policy = new WorkbenchNetworkPolicy(resolver);
  let handler: ((route: any) => Promise<void>) | undefined;
  await policy.install({ route: async (_pattern: string, value: typeof handler) => void (handler = value) } as any);
  assert.ok(handler);

  const exercise = async (url: string, navigation: boolean) => {
    let continued = false;
    let aborted = false;
    await handler!({
      request: () => ({ url: () => url, isNavigationRequest: () => navigation }),
      continue: async () => void (continued = true),
      abort: async () => void (aborted = true),
    });
    return { continued, aborted };
  };
  assert.deepEqual(await exercise("https://public.example", true), { continued: true, aborted: false });
  assert.deepEqual(await exercise("https://metadata.example/latest", false), { continued: false, aborted: true });
  assert.deepEqual(await exercise("https://metadata.example/redirect", true), { continued: false, aborted: true });
});
