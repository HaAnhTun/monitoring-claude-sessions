// Text on demand (02 5.7, ADR 0016): the database holds references to the provider's transcript, never its text. A
// `TranscriptRef` names one record of one file; `readEntryText` checks that the file is still the one the reference was made
// from, reads exactly that record, and returns the legacy display entries of it (`displayEntries`, 03 7.1). Nothing is cached
// and nothing is persisted. The text is untrusted data (brief 12).
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { MAX_LINE_BYTES } from '@mcs/shared/protocol';

import type { InstanceDb, RepoContext } from '../../db/open.ts';
import { TranscriptFilesRepo } from '../../db/repos/transcript-files.ts';
import { displayEntries, type DisplayEntry } from '../../transcript/entries.ts';
import { classifyFsError, errorCodeOf } from '../tail/file-identity.ts';

/** One record of one transcript file, with the identity of the file it was made from (02 5.7). */
export interface TranscriptRef {
  readonly fileId: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly ino: string | null;
  readonly headHash: string | null;
}

export interface EntryTextFailure {
  readonly ok: false;
  /** `REF_STALE`: the file is not the one of the reference, or the bytes are no record. `READ_FAILED`: it cannot be read. */
  readonly reason: 'REF_STALE' | 'READ_FAILED' | 'NOT_FOUND';
}

export interface EntryTextOptions {
  /** Clip of a text entry in code points (default 6000, the legacy `text_chars`). */
  readonly textChars?: number;
}

const DEFAULT_TEXT_CHARS = 6000;
const STALE: EntryTextFailure = { ok: false, reason: 'REF_STALE' };
const FAILED: EntryTextFailure = { ok: false, reason: 'READ_FAILED' };
const NOT_FOUND: EntryTextFailure = { ok: false, reason: 'NOT_FOUND' };

function sound(ref: TranscriptRef): boolean {
  return (
    Number.isSafeInteger(ref.fileId) &&
    Number.isSafeInteger(ref.byteOffset) &&
    ref.byteOffset >= 0 &&
    Number.isSafeInteger(ref.byteLength) &&
    ref.byteLength >= 1
  );
}

/**
 * The display entries of the record `ref` points at, or why there are none.
 * - the reference must come from the identity the file row holds now (`ino`, head hash), and the file on disk must still
 *   have that identity: the first `head_len` bytes hash to the stored head hash and the inode is the stored one;
 * - `[byteOffset, byteOffset + byteLength)` must lie inside the file (`MAX_LINE_BYTES` at most) and parse as a JSON object.
 */
export async function readEntryText(
  db: InstanceDb,
  scope: RepoContext,
  ref: TranscriptRef,
  opts: EntryTextOptions = {},
): Promise<DisplayEntry[] | EntryTextFailure> {
  if (!sound(ref)) return STALE;
  if (ref.byteLength > MAX_LINE_BYTES) return FAILED;
  const row = new TranscriptFilesRepo(db).get(scope, ref.fileId);
  if (row === undefined) return NOT_FOUND;
  if (ref.ino !== row.ino || ref.headHash !== row.headHash) return STALE;

  let handle;
  try {
    handle = await open(row.path, 'r');
  } catch (error) {
    return classifyFsError(errorCodeOf(error)) === 'missing' ? NOT_FOUND : FAILED;
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile()) return FAILED;
    if (row.ino !== null && String(st.ino) !== row.ino) return STALE;
    if (row.headHash !== null) {
      const head = Buffer.alloc(Math.min(row.headLen, Number(st.size)));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const hash = createHash('sha256').update(head.subarray(0, bytesRead)).digest('hex');
      if (bytesRead < row.headLen || hash !== row.headHash) return STALE;
    }
    if (ref.byteOffset + ref.byteLength > Number(st.size)) return STALE;
    const bytes = Buffer.alloc(ref.byteLength);
    const { bytesRead } = await handle.read(bytes, 0, ref.byteLength, ref.byteOffset);
    if (bytesRead < ref.byteLength) return STALE;
    let record: unknown;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch {
      return STALE;
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return STALE;
    return displayEntries(record, { textChars: opts.textChars ?? DEFAULT_TEXT_CHARS });
  } catch {
    return FAILED;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
