import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SecretDropService } from "./service.js";

function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          headers: { Host: "drop.example", ...options.headers },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (x) => (body += x));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end(options.body);
    },
  );
}
test("secret drop stores only after same-origin CSRF form post and never audits the value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-drop-"));
  const env = join(dir, ".env");
  const audit = join(dir, "audit.jsonl");
  const port = 18791 + Math.floor(Math.random() * 1000);
  try {
    await writeFile(env, "OTHER=one\n", { mode: 0o600 });
    const notices: string[] = [];
    const service = new SecretDropService({
      publicBaseUrl: "https://drop.example",
      port,
      envPath: env,
      auditPath: audit,
      notify: async (_id, text) => {
        notices.push(text);
      },
    });
    await service.start();
    const created = await service.create("KERNEL_API_KEY", 5, 1);
    const path = new URL(created.url).pathname;
    assert.match(created.url, /[A-Za-z0-9_-]{43}/);
    const get = await call(port, path);
    assert.equal(get.status, 200);
    assert.equal(get.headers["cache-control"], "no-store, max-age=0");
    const csrf = /name="csrf" value="([^"]+)"/.exec(get.body)![1]!;
    const secret = "kernel-value-not-in-audit";
    const body = new URLSearchParams({ csrf, secret }).toString();
    const post = await call(port, path, {
      method: "POST",
      headers: {
        Origin: "https://drop.example",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(post.status, 200);
    assert.match(post.body, /Submission received/);
    assert.equal(await readFile(env, "utf8"), "OTHER=one\nKERNEL_API_KEY=kernel-value-not-in-audit\n");
    assert.equal((await stat(env)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(audit, "utf8"), /kernel-value-not-in-audit/);
    assert.match(notices[0]!, /stored/i);
    assert.equal((await call(port, path)).status, 404);
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("secret drop rejects wrong host/origin and nonallowlisted creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-drop-"));
  const port = 19891 + Math.floor(Math.random() * 1000);
  try {
    const service = new SecretDropService({
      publicBaseUrl: "https://drop.example",
      port,
      envPath: join(dir, ".env"),
      auditPath: join(dir, "audit"),
      notify: async () => undefined,
    });
    await assert.rejects(() => service.create("NOPE", 5, 1));
    await service.start();
    const path = new URL((await service.create("KERNEL_API_KEY", 5, 1)).url).pathname;
    assert.equal((await call(port, path, { headers: { Host: "evil.example" } })).status, 404);
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent submissions atomically claim a drop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-drop-"));
  const port = 20991 + Math.floor(Math.random() * 1000);
  const notices: string[] = [];
  try {
    const env = join(dir, ".env");
    const audit = join(dir, "audit");
    const service = new SecretDropService({
      publicBaseUrl: "https://drop.example",
      port,
      envPath: env,
      auditPath: audit,
      notify: async (_id, text) => {
        notices.push(text);
      },
    });
    await service.start();
    const path = new URL((await service.create("KERNEL_API_KEY", 5, 1)).url).pathname;
    const form = await call(port, path);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)![1]!;
    const body = new URLSearchParams({ csrf, secret: "one-winner" }).toString();
    const options = {
      method: "POST",
      headers: {
        Origin: "https://drop.example",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    };
    const results = await Promise.all([call(port, path, options), call(port, path, options)]);
    assert.equal(results.filter((result) => result.status === 200).length, 1);
    assert.equal(results.filter((result) => result.status !== 200).length, 1);
    assert.equal((await readFile(env, "utf8")).match(/^KERNEL_API_KEY=/m)?.length, 1);
    assert.equal(notices.filter((notice) => /stored/i.test(notice)).length, 1);
    const stored = (await readFile(audit, "utf8")).match(/"event":"stored"/g) ?? [];
    assert.equal(stored.length, 1);
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects query routes and EnvironmentFile metacharacters without changing env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "secret-drop-"));
  const port = 22001 + Math.floor(Math.random() * 1000);
  try {
    const env = join(dir, ".env");
    await writeFile(env, "OTHER=unchanged\n", { mode: 0o600 });
    const service = new SecretDropService({
      publicBaseUrl: "https://drop.example",
      port,
      envPath: env,
      auditPath: join(dir, "audit"),
      notify: async () => undefined,
    });
    await service.start();
    const path = new URL((await service.create("KERNEL_API_KEY", 5, 1)).url).pathname;
    assert.equal((await call(port, `${path}?secret=not-accepted`)).status, 404);
    const form = await call(port, path);
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)![1]!;
    const body = new URLSearchParams({ csrf, secret: "valid-looking\\\nOTHER=overwritten" }).toString();
    const result = await call(port, path, {
      method: "POST",
      headers: {
        Origin: "https://drop.example",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(result.status, 400);
    assert.equal(await readFile(env, "utf8"), "OTHER=unchanged\n");
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
