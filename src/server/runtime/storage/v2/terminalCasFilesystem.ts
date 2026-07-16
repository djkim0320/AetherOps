import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const TERMINAL_STREAM_CHUNK_BYTES = 1024 * 1024;

export interface ExpectedTerminalFile {
  casHash: string;
  byteLength: number;
}

export function hashTerminalRegularFile(path: string, maximumBytes: number): { hash: string; byteLength: number } {
  const result = readAndHash(path, maximumBytes);
  return { hash: result.hash, byteLength: result.byteLength };
}

export function copyExpectedTerminalFile(source: string, destination: string, expected: ExpectedTerminalFile, maximumBytes: number): void {
  const before = lstatSync(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Canonical terminal CAS object is not a regular file.");
  const sourceFd = openNoFollow(source);
  let destinationFd: number | undefined;
  let copied = false;
  try {
    destinationFd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(TERMINAL_STREAM_CHUNK_BYTES);
    let offset = 0;
    for (;;) {
      const count = readSync(sourceFd, chunk, 0, chunk.byteLength, offset);
      if (!count) break;
      offset += count;
      if (offset > maximumBytes) throw new Error("Canonical terminal lease copy exceeds the bounded byte limit.");
      hash.update(chunk.subarray(0, count));
      writeAll(destinationFd, chunk.subarray(0, count));
    }
    assertUnchanged(before, fstatSync(sourceFd, { bigint: true }), "CAS object changed during lease copy");
    if (offset !== expected.byteLength || hash.digest("hex") !== expected.casHash) {
      throw new Error("Canonical terminal lease copy does not match its immutable attestation.");
    }
    fsyncSync(destinationFd);
    copied = true;
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
    if (!copied) removeTerminalFile(destination);
  }
}

export interface TerminalReadHandle {
  fd: number;
  stat: BigIntStats;
}

export function openTerminalReadHandle(path: string, expected: ExpectedTerminalFile, maximumBytes: number): TerminalReadHandle {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Canonical terminal lease is not a regular file.");
  if (before.size > BigInt(maximumBytes) || before.size !== BigInt(expected.byteLength)) {
    throw new Error("Canonical terminal lease size does not match its immutable attestation.");
  }
  const fd = openNoFollow(path);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assertUnchanged(before, opened, "lease changed while opening its read handle");
    return { fd, stat: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function assertTerminalReadHandleUnchanged(fd: number, before: BigIntStats): void {
  assertUnchanged(before, fstatSync(fd, { bigint: true }), "lease changed during sequential read");
}

export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

export function boundedTerminalFiles(root: string, maximum: number, realRoot: string): string[] {
  const pending = [root];
  const files: string[] = [];
  while (pending.length && files.length < maximum) {
    const directory = pending.pop()!;
    assertTerminalRealDirectory(directory, realRoot);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Canonical terminal CAS contains a symbolic-link path component.");
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      if (files.length >= maximum) break;
    }
  }
  return files;
}

export function boundedMatchingTerminalFiles(
  root: string,
  maximum: number,
  realRoot: string,
  matches: (path: string) => boolean
): { files: string[]; complete: boolean } {
  const pending = [root];
  const files: string[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    assertTerminalRealDirectory(directory, realRoot);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Canonical terminal CAS contains a symbolic-link path component.");
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && matches(path)) {
        files.push(path);
        if (files.length > maximum) return { files: files.slice(0, maximum), complete: false };
      }
    }
  }
  return { files, complete: true };
}

export function secureTerminalDirectoryTree(base: string, segments: string[], create: boolean): string {
  if (!existsSync(base)) {
    if (!create) throw new Error("Canonical terminal CAS directory is unavailable.");
    mkdirSync(base, { recursive: true });
  }
  const baseStat = lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error("Canonical terminal CAS data root is not a regular directory.");
  const realBase = realpathSync.native(base);
  let current = base;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
      throw new Error("Canonical terminal CAS directory component is malformed.");
    }
    current = join(current, segment);
    if (!existsSync(current)) {
      if (!create) throw new Error("Canonical terminal CAS directory is unavailable.");
      mkdirSync(current);
    }
    assertTerminalRealDirectory(current, realBase);
  }
  return current;
}

export function removeBoundedTerminalTree(path: string, dataRoot: string, maximumEntries: number): void {
  const realRoot = realpathSync.native(dataRoot);
  assertTerminalRealDirectory(path, realRoot);
  const pending = [path];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    assertTerminalRealDirectory(directory, realRoot);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > maximumEntries) throw new Error("Canonical terminal lease cleanup exceeds its bounded entry limit.");
      if (entry.isSymbolicLink()) throw new Error("Canonical terminal lease cleanup rejects symbolic-link entries.");
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
  const scoped = relative(realRoot, realpathSync.native(path));
  if (!scoped || scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
    throw new Error("Canonical terminal lease cleanup path escapes its data root.");
  }
  rmSync(path, { recursive: true, force: true });
}

export function removeTerminalFile(path: string): void {
  rmSync(path, { force: true });
}

function readAndHash(path: string, maximumBytes: number): { hash: string; byteLength: number } {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Canonical terminal file is not a regular file.");
  const fd = openNoFollow(path);
  const hash = createHash("sha256");
  let fileOffset = 0;
  try {
    const chunk = Buffer.allocUnsafe(TERMINAL_STREAM_CHUNK_BYTES);
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.byteLength, fileOffset);
      if (!count) break;
      fileOffset += count;
      if (fileOffset > maximumBytes) throw new Error("Canonical terminal file exceeds the bounded byte limit.");
      hash.update(chunk.subarray(0, count));
    }
    assertUnchanged(before, fstatSync(fd, { bigint: true }), "file changed during verified read");
  } finally {
    closeSync(fd);
  }
  return { hash: hash.digest("hex"), byteLength: fileOffset };
}

function openNoFollow(path: string): number {
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  return openSync(path, constants.O_RDONLY | noFollow);
}

function assertUnchanged(before: BigIntStats, after: BigIntStats, message: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error(`Canonical terminal ${message}.`);
  }
}

function assertTerminalRealDirectory(path: string, realRoot: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Canonical terminal path component is not a regular directory.");
  const real = realpathSync.native(path);
  const scoped = relative(realRoot, real);
  if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
    throw new Error("Canonical terminal directory escapes its data root.");
  }
}
