#!/usr/bin/env node
// Orchestrate a manual release: bump package.json version + prepend a CHANGELOG section.
// Usage:
//   node skills/release/scripts/release.mjs patch --message="fix foo"
//   node skills/release/scripts/release.mjs minor --message-file=notes.md
//   node skills/release/scripts/release.mjs --set=1.2.3 --message="explicit bump"
//
// Bump types: patch (default) | minor | major
// If --message is omitted, the new section gets a `- _Describe changes_` placeholder
// and the script warns about it.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(here), "../../..");
const packageJsonPath = resolve(repoRoot, "package.json");
const changelogPath = resolve(repoRoot, "CHANGELOG.md");
const bumpScript = resolve(repoRoot, "scripts/bump-version.mjs");

const args = process.argv.slice(2);
const setArg = args.find((a) => a.startsWith("--set="));
const messageArg = args.find((a) => a.startsWith("--message="));
const messageFileArg = args.find((a) => a.startsWith("--message-file="));
const positional = args.filter((a) => !a.startsWith("--"));

const bumpType = positional[0] ?? "patch";
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error(`error: unknown bump type '${bumpType}' (expected patch|minor|major)`);
  process.exit(2);
}

function getMessage() {
  if (messageFileArg) {
    const p = messageFileArg.slice("--message-file=".length);
    return readFileSync(p, "utf-8").trim();
  }
  if (messageArg) return messageArg.slice("--message=".length).trim();
  return "";
}

function runBump() {
  const bumpArgs = [bumpScript, bumpType];
  if (setArg) bumpArgs.push(setArg);
  const result = spawnSync("node", bumpArgs, { encoding: "utf-8" });
  if (result.status !== 0) {
    console.error(result.stderr || `bump-version exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  return pkg.version;
}

function prependChangelog(version, message) {
  let existing;
  try {
    existing = readFileSync(changelogPath, "utf-8");
  } catch {
    existing = "# Changelog\n\n";
  }
  const lines = [`## ${version}`, ""];
  if (message) {
    for (const line of message.split(/\r?\n/)) {
      lines.push(line.trim() ? `- ${line.trim()}` : "");
    }
  } else {
    lines.push("- _Describe changes_");
  }
  const section = lines.join("\n");
  const headerMatch = existing.match(/^# Changelog\s*\n+/);
  let next;
  if (headerMatch) {
    const headerEnd = headerMatch[0].length;
    next = existing.slice(0, headerEnd) + section + "\n\n" + existing.slice(headerEnd).replace(/^\s+/, "");
  } else {
    next = `# Changelog\n\n${section}\n\n`;
  }
  writeFileSync(changelogPath, next, "utf-8");
}

const previousVersion = readPackageVersion();
const newVersion = runBump();
const message = getMessage();

prependChangelog(newVersion, message);

console.log(`bumped: ${previousVersion} -> ${newVersion}`);
console.log(`changelog: ${changelogPath}`);
if (!message) {
  console.warn("warning: no --message provided; left a `_Describe changes_` placeholder in CHANGELOG.md");
  console.warn('         edit it before committing, or re-run with --message="..."');
}
console.log("");
console.log("suggested commit message:");
console.log(`  chore(release): v${newVersion}`);
console.log("");
console.log("next steps:");
console.log("  git diff --stat");
console.log(`  git add package.json CHANGELOG.md`);
console.log(`  git commit -m "chore(release): v${newVersion}"`);
console.log("  # then follow the PR-only flow in the github-pr skill; safe deploy never pushes main");
