import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
};

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const repoRoot = dirname(packageJsonPath);
const semverRe =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface VersionInfo {
  name: string;
  version: string;
  commit: string;
  branch: string;
  dirty: boolean;
  tag?: string;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
}

export function isSemver(version: string): boolean {
  return semverRe.test(version);
}

export function readPackageVersion(): string {
  const version = String(readPackageJson().version ?? "").trim();
  if (!isSemver(version)) {
    throw new Error(`package.json version is not valid semver: ${version || "<empty>"}`);
  }
  return version;
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function gitFirstLine(args: string[]): string | undefined {
  return git(args)?.split("\n").map((line) => line.trim()).find(Boolean);
}

export function collectVersionInfo(): VersionInfo {
  const pkg = readPackageJson();
  const version = readPackageVersion();
  const commit = git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
  const dirty = Boolean(git(["status", "--porcelain"]));
  const tag = gitFirstLine(["tag", "--points-at", "HEAD", "--sort=-creatordate"]);
  return {
    name: pkg.name ?? "jarvis",
    version,
    commit,
    branch,
    dirty,
    tag,
  };
}

export function formatVersionInfo(info: VersionInfo): string {
  const suffix = [
    info.commit !== "unknown" ? info.commit : undefined,
    info.branch !== "unknown" ? info.branch : undefined,
    info.dirty ? "dirty" : "clean",
  ]
    .filter(Boolean)
    .join(" • ");
  return suffix ? `${info.name} v${info.version} • ${suffix}` : `${info.name} v${info.version}`;
}

export function renderVersionBlock(info: VersionInfo = collectVersionInfo()): string {
  const lines = [
    `${info.name} v${info.version}`,
    `Commit: ${info.commit}`,
    `Branch: ${info.branch}`,
    `State: ${info.dirty ? "dirty" : "clean"}`,
  ];
  if (info.tag) lines.splice(2, 0, `Tag: ${info.tag}`);
  return lines.join("\n");
}

export function versionLabel(): string {
  return `JARVIS v${collectVersionInfo().version}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(renderVersionBlock());
}
