import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allTools } from "./index.js";
import {
  createSendArtifactTool,
  MAX_TELEGRAM_CAPTION_LENGTH,
  prepareArtifact,
  type PreparedArtifact,
} from "./send-artifact.js";

test("send_artifact is run-scoped rather than available to scheduled/background agents", () => {
  assert.equal(
    allTools.some((tool) => tool.name === "send_artifact"),
    false,
  );
});

test("prepareArtifact accepts bounded regular files and normalizes delivery metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-send-artifact-"));
  try {
    const file = join(root, "report@final.JSON");
    await writeFile(file, '{"ok":true}', "utf-8");
    const artifact = await prepareArtifact(file, `  ${"x".repeat(MAX_TELEGRAM_CAPTION_LENGTH + 10)}  `, {
      allowedRoots: [root],
      blockedRoots: [],
      blockedFiles: [],
    });
    assert.equal(artifact.fileName, "report_final.JSON");
    assert.equal(artifact.mimeType, "application/json");
    assert.equal(artifact.size, 11);
    assert.equal(Array.from(artifact.caption ?? "").length, MAX_TELEGRAM_CAPTION_LENGTH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareArtifact rejects URLs, directories, symlinks, protected files, roots, and oversized files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-send-artifact-"));
  const outside = await mkdtemp(join(tmpdir(), "jarvis-send-artifact-outside-"));
  try {
    const file = join(root, "report.txt");
    const secret = join(root, ".env");
    const link = join(root, "link.txt");
    const protectedDir = join(root, "sessions");
    const protectedFile = join(protectedDir, "chat.jsonl");
    const outsideFile = join(outside, "outside.txt");
    await writeFile(file, "report", "utf-8");
    await writeFile(secret, "TOKEN=secret", "utf-8");
    await symlink(file, link);
    await mkdir(protectedDir);
    await writeFile(protectedFile, "private", "utf-8");
    await writeFile(outsideFile, "outside", "utf-8");

    await assert.rejects(prepareArtifact("https://example.com/file.pdf", undefined, { allowedRoots: [root] }), /local/);
    await assert.rejects(prepareArtifact(root, undefined, { allowedRoots: [root] }), /regular file/);
    await assert.rejects(prepareArtifact(link, undefined, { allowedRoots: [root] }), /symbolic link/);
    await assert.rejects(
      prepareArtifact(secret, undefined, { allowedRoots: [root], blockedRoots: [], blockedFiles: [] }),
      /secret/,
    );
    await assert.rejects(
      prepareArtifact(protectedFile, undefined, { allowedRoots: [root], blockedRoots: [protectedDir] }),
      /protected/,
    );
    await assert.rejects(prepareArtifact(outsideFile, undefined, { allowedRoots: [root] }), /outside/);
    await assert.rejects(
      prepareArtifact(file, undefined, { allowedRoots: [root], blockedRoots: [], blockedFiles: [], maxBytes: 2 }),
      /too large/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("send_artifact records the boundary before upload, audits metadata, and refuses duplicate delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-send-artifact-"));
  try {
    const file = join(root, "screenshot.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const events: string[] = [];
    const sent: PreparedArtifact[] = [];
    const audits: Array<{ args: unknown; bytes?: number; outcome: string }> = [];
    const tool = createSendArtifactTool({
      allowedRoots: [root],
      blockedRoots: [],
      blockedFiles: [],
      beforeDelivery: async () => {
        events.push("boundary");
      },
      send: async (artifact) => {
        events.push("send");
        sent.push(artifact);
        return { messageId: 42 };
      },
      audit: async (entry) => {
        audits.push(entry);
      },
    });

    const result = await tool.execute("send-1", { path: file, caption: "Browser result" }, undefined);
    assert.deepEqual(events, ["boundary", "send"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.mimeType, "image/png");
    assert.deepEqual(result.details, {
      messageId: 42,
      fileName: "screenshot.png",
      size: 3,
      mimeType: "image/png",
    });
    assert.equal(audits[0]?.outcome, "ok");
    assert.equal(audits[0]?.bytes, 3);
    assert.deepEqual(audits[0]?.args, {
      path: await realpath(file),
      size: 3,
      mime_type: "image/png",
      has_caption: true,
    });

    await assert.rejects(tool.execute("send-2", { path: file }, undefined), /already delivered/);
    assert.equal(sent.length, 1);
    assert.deepEqual(events, ["boundary", "send"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("send_artifact refuses upload when the durable side-effect boundary cannot be recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-send-artifact-"));
  try {
    const file = join(root, "report.md");
    await writeFile(file, "# report", "utf-8");
    let sends = 0;
    const tool = createSendArtifactTool({
      allowedRoots: [root],
      blockedRoots: [],
      blockedFiles: [],
      beforeDelivery: async () => {
        throw new Error("journal unavailable");
      },
      send: async () => {
        sends += 1;
        return { messageId: 1 };
      },
      audit: async () => undefined,
    });
    await assert.rejects(tool.execute("send-1", { path: file }, undefined), /journal unavailable/);
    assert.equal(sends, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
