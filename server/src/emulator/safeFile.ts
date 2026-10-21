import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

/** Upper bound for the small text files the server reads from other programs (discovery files, AVD configs). */
export const MAX_SMALL_FILE_BYTES = 64 * 1024;

// Not defined on Windows; there the file-type check below still applies.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export interface SmallFileOptions {
  maxBytes?: number;
  /** POSIX: the file must belong to this user (the server's own uid). */
  owner?: number;
}

/**
 * The text of a small regular file, or null. A symlink (O_NOFOLLOW), FIFO or device (opened non-blocking, then
 * refused by fstat), a file of another user, or one over `maxBytes` is not read. The checks run on the open file
 * descriptor, so the file cannot be swapped between check and read.
 */
export async function readSmallFile(file: string, options: SmallFileOptions = {}): Promise<string | null> {
  const maxBytes = options.maxBytes ?? MAX_SMALL_FILE_BYTES;
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return null;
    if (options.owner !== undefined && stats.uid !== options.owner) return null;
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxBytes ? null : buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export type DirectoryCheck = 'ok' | 'missing' | 'unsafe';

/**
 * POSIX: `dir` must be a real directory (not a symlink) of `owner` that nobody else can write to; else files in
 * it could be planted by another local user (e.g. under a shared /tmp).
 */
export async function checkPrivateDirectory(dir: string, owner: number | undefined): Promise<DirectoryCheck> {
  let stats;
  try {
    stats = await lstat(dir);
  } catch {
    return 'missing';
  }
  if (!stats.isDirectory()) return 'unsafe';
  if (owner === undefined) return 'ok';
  return stats.uid === owner && (stats.mode & 0o022) === 0 ? 'ok' : 'unsafe';
}
