// File identity for the tailer (02 5.3, ADR 0015): the inode as a decimal string plus the sha256 of the first (up to)
// 256 bytes. A change of either, or a size below a consumed cursor, means the bytes the cursors point at are gone.
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';

/** `ino` is `String(stat({bigint: true}).ino)` (a 64-bit id does not fit a Number); `headLen` is at most 256. */
export interface FileIdentity {
  ino: string | null;
  headLen: number;
  headHash: string;
}

export type IdentityCheck =
  | { kind: 'unchanged' | 'grown'; stat: BigIntStats }
  | { kind: 'reset'; reason: 'truncated' | 'replaced'; stat: BigIntStats }
  | { kind: 'missing' }
  | { kind: 'unreadable'; code: string };

/** Bytes of the head that identify a file. */
export const IDENTITY_HEAD_BYTES = 256;

/** Error code of a failed file call, `'UNKNOWN'` when the error carries none. */
export function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN';
}

/** ENOENT and ENOTDIR mean the path is gone (cursors are kept); every other failure means it cannot be read now. */
export function classifyFsError(code: string): 'missing' | 'unreadable' {
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
}

export function hashHead(head: Uint8Array): string {
  return createHash('sha256').update(head).digest('hex');
}

/** The first `min(256, size)` bytes of the file. */
async function readHead(path: string, size: number): Promise<Buffer> {
  const length = Math.min(IDENTITY_HEAD_BYTES, size);
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const handle = await open(path, 'r');
  try {
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

function inoOf(st: BigIntStats): string {
  return String(st.ino);
}

/** The identity of the file as it is now. Rejects with the file system error when the file cannot be read. */
export async function readIdentity(path: string, known?: BigIntStats): Promise<FileIdentity> {
  const st = known ?? (await stat(path, { bigint: true }));
  const head = await readHead(path, Number(st.size));
  return { ino: inoOf(st), headLen: head.length, headHash: hashHead(head) };
}

/**
 * Compares the file with what was stored (02 5.3 `checkIdentity`).
 * 1. ENOENT: `missing` (cursors are kept); EACCES, EBUSY, EPERM and the like: `unreadable`.
 * 2. A stored inode that differs: `reset/replaced` (replace-by-rename and delete-recreate change it).
 * 3. Size below `lowestCursor` (the smallest cursor that consumed bytes): `reset/truncated`.
 * 4. When the size or the mtime changed since the last check, the head is read and its prefix (`stored.headLen` bytes)
 *    must hash to `stored.headHash`, else `reset/replaced` (a rewrite in place keeps the inode). With no stored mtime the
 *    head is verified on every call. A head that is shorter than 256 bytes is extended by the caller (`readIdentity`).
 * 5. Else `grown` (larger than `storedSize`) or `unchanged`.
 */
export async function checkIdentity(
  path: string,
  stored: FileIdentity | null,
  storedSize: number,
  lowestCursor: number,
  storedMtimeMs: number | null = null,
): Promise<IdentityCheck> {
  let st: BigIntStats;
  try {
    st = await stat(path, { bigint: true });
  } catch (error) {
    const code = errorCodeOf(error);
    return classifyFsError(code) === 'missing' ? { kind: 'missing' } : { kind: 'unreadable', code };
  }
  if (!st.isFile()) return { kind: 'unreadable', code: st.isDirectory() ? 'EISDIR' : 'ENOTSUP' };
  const size = Number(st.size);
  if (stored !== null && stored.ino !== null && stored.ino !== inoOf(st)) {
    return { kind: 'reset', reason: 'replaced', stat: st };
  }
  if (size < lowestCursor) return { kind: 'reset', reason: 'truncated', stat: st };
  if (stored !== null) {
    const changed = size !== storedSize || storedMtimeMs === null || Number(st.mtimeMs) !== storedMtimeMs;
    if (changed) {
      if (size < stored.headLen) return { kind: 'reset', reason: 'truncated', stat: st };
      let head: Buffer;
      try {
        head = await readHead(path, size);
      } catch (error) {
        const code = errorCodeOf(error);
        return classifyFsError(code) === 'missing' ? { kind: 'missing' } : { kind: 'unreadable', code };
      }
      if (hashHead(head.subarray(0, stored.headLen)) !== stored.headHash) {
        return { kind: 'reset', reason: 'replaced', stat: st };
      }
    }
  }
  return { kind: size > storedSize ? 'grown' : 'unchanged', stat: st };
}
