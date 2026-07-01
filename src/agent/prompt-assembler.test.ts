import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, type PromptAssemblyPaths } from "./prompt-assembler.js";

async function makeAssemblyPaths(): Promise<PromptAssemblyPaths> {
  const root = await mkdtemp(join(tmpdir(), "jarvis-prompt-"));
  const prompts = join(root, "prompts");
  await mkdir(prompts, { recursive: true });
  await writeFile(join(prompts, "system.md"), "Base prompt\n", "utf-8");
  return {
    systemPrompt: join(prompts, "system.md"),
    adaptiveVoicePrompt: join(prompts, "SOUL.md"),
    sourceSkills: join(root, "missing-source-skills"),
    localSkills: join(root, "missing-local-skills"),
    mcpConfig: join(root, "missing-mcp.json"),
  };
}

test("buildSystemPrompt includes host-local SOUL.md when present", async () => {
  const assemblyPaths = await makeAssemblyPaths();
  await writeFile(assemblyPaths.adaptiveVoicePrompt, "- Keep it concise.\n- Never say sir.\n", "utf-8");

  const prompt = buildSystemPrompt(assemblyPaths);

  assert.match(prompt, /^Base prompt/);
  assert.match(prompt, /## Adaptive Voice Memory/);
  assert.match(prompt, /Host-local file: `~\/\.jarvis\/prompts\/SOUL\.md`\./);
  assert.match(prompt, /- Keep it concise\./);
  assert.match(prompt, /- Never say sir\./);
});

test("buildSystemPrompt omits adaptive voice section when SOUL.md is absent", async () => {
  const assemblyPaths = await makeAssemblyPaths();

  const prompt = buildSystemPrompt(assemblyPaths);

  assert.equal(prompt, "Base prompt");
  assert.doesNotMatch(prompt, /Adaptive Voice Memory/);
});
