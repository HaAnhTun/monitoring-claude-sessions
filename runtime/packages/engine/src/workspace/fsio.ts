// Workspace file rules on top of the platform file primitives (01 1.2, ADR 0058). One writer, one reader: `platform/fsx.ts`
// does the atomic replace and the short read-and-close; this module adds what only a workspace needs (no link is ever
// followed or written through, `McsError` codes, JSON files in the one layout of `json/write.ts`, universal newlines). It defines no second
// retry policy; the only addition is the append used by the audit trail, which uses the same schedule.
import { lstatSync } from 'node:fs';
import { appendFile, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { McsError } from '@mcs/shared';

import { AtomicWriteError, SmallFileError, atomicWriteFile, readSmallFile, unlinkWithRetry } from '../platform/fsx.ts';
import { JsonSyntaxError, parseJson, jsonFileText, type JsonDoc } from '../json/index.ts';

/** Largest text file `readTextUniversal` reads unless the caller says otherwise (01 1.2). */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024;

/** How long a write keeps retrying a sharing violation (design 06's budget; E5 measured 352 ms for a 1 s holder). */
export const DEFAULT_BUDGET_MS = 3000;

export interface WriteOptions {
  /** Retry budget in ms (default `DEFAULT_BUDGET_MS`). */
  readonly budgetMs?: number;
}

const BUSY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const OPEN_RETRIES = 10;
const OPEN_RETRY_DELAY_MS = 20;

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code;
  return undefined;
}

function reasonOf(error: unknown): string {
  const code = errorCode(error);
  if (code !== undefined) return code;
  return error instanceof Error ? error.message : String(error);
}

/** True for the Node error of a path that is not there (a missing file, or a file used as a folder). */
export function isMissingFileError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * True when `target` is a symbolic link or, on Windows, a junction (`lstat` reports both, E5). An absent path, or one below
 * a file, is not a link; any other failure to look is `WORKSPACE_INVALID`.
 */
export function isLink(target: string): boolean {
  try {
    return lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw new McsError('WORKSPACE_INVALID', `cannot inspect ${path.basename(target)}: ${reasonOf(error)}`, {
      cause: error,
    });
  }
}

/**
 * Throws `WORKSPACE_SYMLINK` when `target` is a link (see `isLink`). An absent path passes: callers use this before they
 * create or replace something.
 */
export function assertNotLink(target: string): void {
  if (isLink(target)) {
    throw new McsError(
      'WORKSPACE_SYMLINK',
      `${target} is a link; a workspace never follows or writes through links (links are refused anywhere below the tasks root)`,
      { details: { path: target } },
    );
  }
}

function replaceFailure(error: unknown, file: string, verb: 'replace' | 'append to'): unknown {
  if (error instanceof AtomicWriteError) {
    return new McsError('WORKSPACE_INVALID', `cannot ${verb} ${path.basename(file)}: ${error.code}`, { cause: error });
  }
  return error;
}

/**
 * Replaces `file` atomically (temp file in the same folder, fsync, rename; sharing violations retried for the budget).
 * Refuses a link as the target and as the parent folder.
 */
export async function writeWorkspaceFile(file: string, data: string | Uint8Array, o: WriteOptions = {}): Promise<void> {
  assertNotLink(file);
  assertNotLink(path.dirname(file));
  try {
    await atomicWriteFile(file, data, { budgetMs: o.budgetMs ?? DEFAULT_BUDGET_MS });
  } catch (error) {
    throw replaceFailure(error, file, 'replace');
  }
}

/**
 * The only writer of `task.json`, `config.json`, `runtime.json`, `instance.json`, `state.json` and backup manifests
 * (ADR 0003, ADR 0067): the indent-2 layout of `json/write.ts` plus one LF, through `writeWorkspaceFile`.
 */
export function writeJsonFile(file: string, value: JsonDoc, o: WriteOptions = {}): Promise<void> {
  return writeWorkspaceFile(file, jsonFileText(value), o);
}

/**
 * Appends `data` to `file` (created when missing) with one `appendFile` of one buffer. This is the only non-atomic write
 * of a workspace (the audit trail, 01 7.1); sharing violations are retried with the schedule of `atomicWriteFile`.
 * Refuses a link as the file and as the parent folder.
 */
export async function appendWorkspaceFile(file: string, data: string, o: WriteOptions = {}): Promise<void> {
  assertNotLink(path.dirname(file));
  assertNotLink(file);
  const bytes = Buffer.from(data, 'utf8');
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      await appendFile(file, bytes);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !BUSY_CODES.has(code)) {
        throw new McsError('WORKSPACE_INVALID', `cannot append to ${path.basename(file)}: ${reasonOf(error)}`, {
          cause: error,
        });
      }
      if (performance.now() - started >= budgetMs) {
        throw new McsError('WORKSPACE_INVALID', `cannot append to ${path.basename(file)}: E_ATOMIC_WRITE_BUSY`, {
          cause: error,
        });
      }
      await sleepMs(Math.min(50 * 2 ** Math.min(attempt, 10), 250));
    }
  }
}

function decodeText(bytes: Uint8Array): string {
  // The default decoder strips one BOM and replaces invalid sequences; Python's text mode would refuse them, but an
  // audit trail or a README that was edited by hand should still be readable.
  return new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/g, '\n');
}

async function readBounded(file: string, maxBytes: number): Promise<Buffer> {
  try {
    return await readSmallFile(file, maxBytes);
  } catch (error) {
    if (error instanceof SmallFileError) {
      throw new McsError(
        'WORKSPACE_INVALID',
        error.code === 'E_FILE_TOO_LARGE'
          ? `${path.basename(file)} is larger than ${String(maxBytes)} bytes`
          : `${path.basename(file)} stayed busy while it was read`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The text of a file with Python's universal newlines (`open(..., encoding='utf-8')`): CRLF and a lone CR become LF and one
 * leading BOM is dropped. A file larger than `maxBytes` is `WORKSPACE_INVALID`; a missing file is the Node error
 * (see `isMissingFileError`).
 */
export async function readTextUniversal(file: string, maxBytes: number = MAX_TEXT_BYTES): Promise<string> {
  return decodeText(await readBounded(file, maxBytes));
}

async function openForRead(file: string): ReturnType<typeof open> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await open(file, 'r');
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !BUSY_CODES.has(code) || attempt >= OPEN_RETRIES) throw error;
      await sleepMs(OPEN_RETRY_DELAY_MS);
    }
  }
}

/**
 * As `readTextUniversal` for the last `maxBytes` bytes of a file: the whole text when the file fits, otherwise only its
 * tail with `truncated: true`. The first line of a tail is usually cut in the middle; callers that parse blocks drop it.
 */
export async function readTextTail(file: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError(`readTextTail: maxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
  const handle = await openForRead(file);
  try {
    // One consistent cut: the bytes [size - length, size) as they were when the size was read, even if the file grows.
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await handle.read(buffer, got, length - got, size - length + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return { text: decodeText(buffer.subarray(0, got)), truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

/**
 * Reads a JSON file as strict UTF-8 text (a BOM or an invalid sequence is an error). Every failure is
 * `CONFIG_UNREADABLE`. The text is returned next to the value so callers can compare bytes.
 */
export async function readJsonFile(file: string): Promise<{ text: string; value: JsonDoc }> {
  let bytes: Buffer;
  try {
    bytes = await readSmallFile(file, MAX_TEXT_BYTES);
  } catch (error) {
    throw new McsError('CONFIG_UNREADABLE', `cannot read ${file}: ${reasonOf(error)}`, { cause: error });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new McsError('CONFIG_UNREADABLE', `${file} is not valid JSON: the file is not valid UTF-8`, { cause: error });
  }
  try {
    return { text, value: parseJson(text) };
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      throw new McsError('CONFIG_UNREADABLE', `${file} is not valid JSON: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Deletes `file` only when it still holds `expected` (a stale `state.json`, a token): `absent` when it was not there,
 * `changed` when somebody wrote other bytes, `deleted` otherwise. Used for every stale-file removal (01 1.2).
 */
export async function compareAndDelete(file: string, expected: Uint8Array): Promise<'deleted' | 'changed' | 'absent'> {
  let current: Buffer;
  try {
    current = await readSmallFile(file, MAX_TEXT_BYTES);
  } catch (error) {
    if (isMissingFileError(error)) return 'absent';
    throw new McsError('WORKSPACE_INVALID', `cannot read ${path.basename(file)}: ${reasonOf(error)}`, { cause: error });
  }
  if (Buffer.compare(current, expected) !== 0) return 'changed';
  try {
    return await unlinkWithRetry(file, DEFAULT_BUDGET_MS);
  } catch (error) {
    if (error instanceof AtomicWriteError) {
      throw new McsError('WORKSPACE_INVALID', `cannot delete ${path.basename(file)}: ${error.code}`, { cause: error });
    }
    throw error;
  }
}
