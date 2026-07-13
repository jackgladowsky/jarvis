#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const semverRe =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length > right.length ? 1 : -1;
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/** Parse a strict SemVer 2.0.0 version without losing integer precision. */
export function parseSemver(version) {
  if (typeof version !== "string") throw new Error("version must be a string");

  const match = semverRe.exec(version);
  if (!match) throw new Error(`not valid SemVer 2.0.0: ${JSON.stringify(version)}`);

  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier)) {
      throw new Error(
        `not valid SemVer 2.0.0: numeric prerelease identifier ${JSON.stringify(identifier)} has a leading zero`,
      );
    }
  }

  return {
    raw: version,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
  };
}

/** Compare parsed SemVer versions according to SemVer 2.0.0 precedence. */
export function compareSemver(left, right) {
  for (const component of ["major", "minor", "patch"]) {
    const comparison = compareNumericStrings(left[component], right[component]);
    if (comparison !== 0) return comparison;
  }

  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }

  const identifiers = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericStrings(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }

  return 0;
}

export function requireVersionIncrease(baseVersion, candidateVersion) {
  const base = parseSemver(baseVersion);
  const candidate = parseSemver(candidateVersion);
  if (compareSemver(candidate, base) <= 0) {
    throw new Error(`package.json version must be strictly greater than main (${base.raw}); PR has ${candidate.raw}`);
  }
}

function packageVersion(json, source) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not parse ${source}: ${message}`, { cause: error });
  }
  if (typeof parsed.version !== "string") throw new Error(`${source} has no string version field`);
  return parsed.version;
}

function fail(message) {
  console.error(`::error title=Version gate::${message}`);
  console.error(`Version gate failed: ${message}`);
  console.error("Bump package.json to a SemVer version strictly greater than the current main version.");
  process.exitCode = 1;
}

function main() {
  const baseSha = process.env.BASE_SHA;
  if (!baseSha || !/^[0-9a-f]{40}$/i.test(baseSha)) {
    fail("BASE_SHA must be the 40-character base commit SHA from the pull request event.");
    return;
  }

  const baseResult = spawnSync("git", ["show", `${baseSha}:package.json`], {
    encoding: "utf8",
  });
  if (baseResult.status !== 0) {
    fail(`could not read package.json from base commit ${baseSha}: ${baseResult.stderr.trim()}`);
    return;
  }

  try {
    const baseVersion = packageVersion(baseResult.stdout, `base commit ${baseSha} package.json`);
    const candidateVersion = packageVersion(readFileSync("package.json", "utf8"), "checked-out package.json");
    requireVersionIncrease(baseVersion, candidateVersion);
    console.log(`Version gate passed: ${candidateVersion} is greater than base main version ${baseVersion}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
