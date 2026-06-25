#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const raw = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

const semverRe =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const bump = process.argv[2] ?? "patch";
const explicit = process.argv.find((arg) => arg.startsWith("--set="))?.slice("--set=".length);

function parse(version) {
  const match = semverRe.exec(version);
  if (!match) throw new Error(`invalid semver: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function format({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

let next;
if (explicit) {
  if (!semverRe.test(explicit)) throw new Error(`invalid semver: ${explicit}`);
  next = explicit;
} else {
  const current = parse(String(raw.version ?? ""));
  if (bump === "major") next = format({ major: current.major + 1, minor: 0, patch: 0 });
  else if (bump === "minor") next = format({ major: current.major, minor: current.minor + 1, patch: 0 });
  else if (bump === "patch") next = format({ major: current.major, minor: current.minor, patch: current.patch + 1 });
  else throw new Error(`usage: bump-version.mjs [patch|minor|major] [--set=x.y.z]`);
}

raw.version = next;
writeFileSync(packageJsonPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
console.log(next);
