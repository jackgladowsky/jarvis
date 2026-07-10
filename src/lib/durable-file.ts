import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  /** File mode used for a newly-created destination. Existing modes survive replacement. */
  mode?: number;
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const LOCK_INITIALIZATION_GRACE_MS = 5_000;

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

async function destinationMode(file: string, requested?: number): Promise<number> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${file}`);
    return requested ?? info.mode & 0o777;
  } catch (err) {
    if (errno(err) !== "ENOENT") throw err;
    return requested ?? 0o600;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Linux supports fsync on directories and needs it for a durable rename.
  // Some development platforms reject directory fsync; the file itself is
  // still synced there, so treat those platform-specific errors as benign.
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (err) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(errno(err) ?? "")) throw err;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Write, fsync, and atomically rename a file in the destination directory. */
export async function atomicWriteFile(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const mode = await destinationMode(file, options.mode);
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteJson(file: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("value is not JSON-serializable");
  await atomicWriteFile(file, `${serialized}\n`, options);
}

function destinationModeSync(file: string, requested?: number): number {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${file}`);
    return requested ?? info.mode & 0o777;
  } catch (err) {
    if (errno(err) !== "ENOENT") throw err;
    return requested ?? 0o600;
  }
}

/** Synchronous equivalent for process-global state updated from sync APIs. */
export function atomicWriteFileSync(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const mode = destinationModeSync(file, options.mode);
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    try {
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (err) {
      if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(errno(err) ?? "")) throw err;
    }
  } catch (err) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original failure.
    }
    throw err;
  }
}

export function atomicWriteJsonSync(file: string, value: unknown, options: AtomicWriteOptions = {}): void {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("value is not JSON-serializable");
  atomicWriteFileSync(file, `${serialized}\n`, options);
}

type ProcessLiveness = "alive" | "dead" | "unknown";

function processLiveness(pid: number): ProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    if (errno(err) === "ESRCH") return "dead";
    if (errno(err) === "EPERM") return "alive";
    return "unknown";
  }
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
  processStart?: string;
}

interface LockSnapshot {
  stale: boolean;
  ownerRaw?: string;
}

interface ReaperOwner {
  token: string;
  pid: number;
  createdAt: number;
  processStart?: string;
}

interface ReaperSnapshot {
  stale: boolean;
  raw?: string;
}

async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf-8");
    const afterCommand = raw
      .slice(raw.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return afterCommand[19]; // Linux procfs field 22 (starttime).
  } catch {
    return undefined;
  }
}

function isCompleteLockOwner(owner: Partial<LockOwner> | undefined): owner is LockOwner {
  return Boolean(
    owner &&
    typeof owner.token === "string" &&
    owner.token.length > 0 &&
    typeof owner.pid === "number" &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.createdAt === "number" &&
    Number.isFinite(owner.createdAt) &&
    (owner.processStart === undefined || (typeof owner.processStart === "string" && owner.processStart.length > 0)),
  );
}

async function inspectLock(lockDirectory: string, staleMs: number): Promise<LockSnapshot> {
  try {
    const info = await stat(lockDirectory);
    let ownerRaw: string | undefined;
    let owner: Partial<LockOwner> | undefined;
    try {
      ownerRaw = await readFile(join(lockDirectory, "owner.json"), "utf-8");
      owner = JSON.parse(ownerRaw) as Partial<LockOwner>;
    } catch {
      // An incomplete owner record can be recovered after the directory ages.
    }
    if (isCompleteLockOwner(owner)) {
      const liveness = processLiveness(owner.pid);
      if (liveness === "dead") return { stale: true, ownerRaw };
      if (liveness === "unknown") return { stale: false, ownerRaw };

      // A live numeric PID is only proof of this owner when its process start
      // also matches. A mismatch proves PID reuse and is safe to reclaim
      // immediately; an unavailable start time remains conservatively owned.
      if (!owner.processStart) return { stale: false, ownerRaw };
      const currentStart = await processStartTime(owner.pid);
      if (!currentStart) return { stale: false, ownerRaw };
      return { stale: owner.processStart !== currentStart, ownerRaw };
    }

    // Missing or malformed owner records may be a creator still initializing.
    // They retain the full age/grace policy because no owner identity exists
    // that can be proved dead.
    const ownerCreatedAt = owner?.createdAt;
    const hasOwnerTimestamp = typeof ownerCreatedAt === "number" && Number.isFinite(ownerCreatedAt);
    const createdAt = hasOwnerTimestamp ? ownerCreatedAt : info.mtimeMs;
    const requiredAge = Math.max(staleMs, LOCK_INITIALIZATION_GRACE_MS);
    if (Date.now() - createdAt < requiredAge) return { stale: false, ownerRaw };
    return { stale: true, ownerRaw };
  } catch (err) {
    if (errno(err) === "ENOENT") return { stale: false };
    throw err;
  }
}

async function inspectReaperMarker(reaperFile: string): Promise<ReaperSnapshot> {
  try {
    const info = await stat(reaperFile);
    let raw: string | undefined;
    let owner: Partial<ReaperOwner> | undefined;
    try {
      raw = await readFile(reaperFile, "utf-8");
      owner = JSON.parse(raw) as Partial<ReaperOwner>;
    } catch {
      // A process can die between creating and filling the marker. Recover it
      // only after the same initialization grace used for incomplete locks.
    }

    const createdAt = typeof owner?.createdAt === "number" ? owner.createdAt : info.mtimeMs;
    if (Date.now() - createdAt < LOCK_INITIALIZATION_GRACE_MS) return { stale: false, raw };
    if (typeof owner?.pid === "number") {
      const liveness = processLiveness(owner.pid);
      if (liveness === "unknown") return { stale: false, raw };
      if (liveness === "alive") {
        const currentStart = await processStartTime(owner.pid);
        if (!owner.processStart || !currentStart || owner.processStart === currentStart) {
          return { stale: false, raw };
        }
      }
    }
    return { stale: true, raw };
  } catch (err) {
    if (errno(err) === "ENOENT") return { stale: false };
    throw err;
  }
}

async function reclaimAbandonedReaperMarker(reaperFile: string, expected: ReaperSnapshot): Promise<boolean> {
  if (!expected.stale) return false;
  let currentRaw: string | undefined;
  try {
    currentRaw = await readFile(reaperFile, "utf-8");
  } catch (err) {
    if (errno(err) === "ENOENT") return true;
    throw err;
  }
  if (currentRaw !== expected.raw) return false;

  // Revalidate liveness immediately before removing the abandoned lease. A
  // recycled PID is not ownership unless its process start time also matches.
  try {
    const owner = JSON.parse(currentRaw) as Partial<ReaperOwner>;
    if (typeof owner.pid === "number") {
      const liveness = processLiveness(owner.pid);
      if (liveness === "unknown") return false;
      if (liveness === "alive") {
        const currentStart = await processStartTime(owner.pid);
        if (!owner.processStart || !currentStart || owner.processStart === currentStart) return false;
      }
    }
  } catch {
    // The age check in inspectReaperMarker protects incomplete legacy markers.
  }

  await rm(reaperFile, { force: true });
  return true;
}

async function claimReaperMarker(reaperFile: string): Promise<{ token: string } | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const marker: ReaperOwner = {
      token,
      pid: process.pid,
      createdAt: Date.now(),
      processStart: await processStartTime(process.pid),
    };
    let handle;
    try {
      handle = await open(reaperFile, "wx", 0o600);
      await handle.writeFile(JSON.stringify(marker));
      await handle.sync();
      await handle.close();
      return { token };
    } catch (err) {
      await handle?.close().catch(() => undefined);
      if (errno(err) === "ENOENT") return undefined;
      if (errno(err) !== "EEXIST") {
        // If creation succeeded but filling the marker failed, remove only the
        // file carrying our token. A crash is handled by the lease path above.
        const raw = await readFile(reaperFile, "utf-8").catch(() => undefined);
        if (raw) {
          try {
            if ((JSON.parse(raw) as Partial<ReaperOwner>).token === token) {
              await rm(reaperFile, { force: true });
            }
          } catch {
            // Leave unrecognized state for grace-period recovery.
          }
        }
        throw err;
      }
      if (attempt > 0) return undefined;
      const existing = await inspectReaperMarker(reaperFile);
      if (!(await reclaimAbandonedReaperMarker(reaperFile, existing))) return undefined;
    }
  }
  return undefined;
}

async function reclaimStaleLock(lockDirectory: string, expected: LockSnapshot): Promise<boolean> {
  if (!expected.stale) return false;
  const reaperFile = join(lockDirectory, "reaping.json");
  const claim = await claimReaperMarker(reaperFile);
  if (!claim) return false;
  const reaperToken = claim.token;

  let renamed = false;
  try {
    // The exclusive marker serializes stale reclaimers. Re-read the exact
    // owner bytes after claiming it, so an observation of an older lock can
    // never be applied to a replacement lock.
    let currentRaw: string | undefined;
    try {
      currentRaw = await readFile(join(lockDirectory, "owner.json"), "utf-8");
    } catch (err) {
      if (errno(err) !== "ENOENT") throw err;
    }
    if (currentRaw !== expected.ownerRaw) return false;
    if (currentRaw) {
      try {
        const owner = JSON.parse(currentRaw) as Partial<LockOwner>;
        if (typeof owner.pid === "number") {
          const liveness = processLiveness(owner.pid);
          if (liveness === "unknown") return false;
          if (liveness === "alive") {
            const currentStart = await processStartTime(owner.pid);
            if (!owner.processStart || !currentStart || owner.processStart === currentStart) return false;
          }
        }
      } catch {
        // Byte identity still protects malformed legacy records.
      }
    }

    // An abandoned reaper marker can be replaced. Fence the old reaper by
    // verifying that this exact token still owns the marker immediately before
    // moving the lock directory.
    const marker = await readFile(reaperFile, "utf-8").catch(() => undefined);
    if (!marker) return false;
    try {
      if ((JSON.parse(marker) as Partial<ReaperOwner>).token !== reaperToken) return false;
    } catch {
      return false;
    }

    const tombstone = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
    await rename(lockDirectory, tombstone);
    renamed = true;
    await rm(tombstone, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (errno(err) === "ENOENT") return false;
    throw err;
  } finally {
    if (!renamed) {
      // No other reaper can replace the marker while ours exists.
      const marker = await readFile(reaperFile, "utf-8").catch(() => undefined);
      if (marker) {
        try {
          if ((JSON.parse(marker) as { token?: string }).token === reaperToken) {
            await rm(reaperFile, { force: true });
          }
        } catch {
          // Leave an unrecognized marker rather than deleting another claim.
        }
      }
    }
  }
}

async function releaseOwnedLock(lockDirectory: string, token: string): Promise<void> {
  let owner: Partial<LockOwner>;
  try {
    owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf-8")) as Partial<LockOwner>;
  } catch (err) {
    throw new Error(`cannot verify lock ownership for ${lockDirectory}`, { cause: err });
  }
  if (owner.token !== token) throw new Error(`lock ownership changed before release: ${lockDirectory}`);

  const tombstone = `${lockDirectory}.release.${process.pid}.${token}`;
  await rename(lockDirectory, tombstone);
  const moved = JSON.parse(await readFile(join(tombstone, "owner.json"), "utf-8")) as Partial<LockOwner>;
  if (moved.token !== token) throw new Error(`lock ownership changed during release: ${lockDirectory}`);
  await rm(tombstone, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cross-process advisory lock for a state file. Callers that mutate the same
 * file must consistently use this helper. Stale lock directories left by a
 * crashed process are reclaimed only after their owner is confirmed dead.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const lockDirectory = `${file}.lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  await mkdir(dirname(file), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDirectory);
      try {
        await atomicWriteJson(join(lockDirectory, "owner.json"), {
          token,
          pid: process.pid,
          createdAt: Date.now(),
          processStart: await processStartTime(process.pid),
        });
      } catch (err) {
        await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      break;
    } catch (err) {
      if (errno(err) !== "EEXIST") throw err;
      const snapshot = await inspectLock(lockDirectory, staleMs);
      if (snapshot.stale && (await reclaimStaleLock(lockDirectory, snapshot))) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for state lock: ${file}`);
      await delay(15 + Math.floor(Math.random() * 35));
    }
  }

  try {
    return await fn();
  } finally {
    await releaseOwnedLock(lockDirectory, token);
  }
}

/** Serialize an append and fsync it before releasing the cross-process lock. */
export async function appendFileDurable(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await withFileLock(file, async () => {
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(file, "a", mode);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
