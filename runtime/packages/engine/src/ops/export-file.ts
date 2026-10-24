// `export` to a file (01 6.4, 03 11.1, T-CLI-13): the path rules and the write. The export is streamed by the `InstanceReader`
// (`exportTo`) into `<out>.tmp`; the file is re-read (line count, size and the checksum of everything before the trailer must be
// what the reader reported) and only then renamed to `<out>`, so the final name never holds a partial or unverified export, and
// a failed or interrupted export leaves no file under it. The file is created with `wx` (never over a leftover) and mode 0600.
//
// Where an export may go (`checkExportPath`, run before anything is read):
//   - the folder of `--out` must exist; its real path (links and junctions resolved) is what the rules below see, so a link to a
//     forbidden folder is the forbidden folder;
//   - never inside the Claude home (`CLAUDE_CONFIG_DIR`, else `~/.claude`);
//   - inside the tasks root only below `logs/` or `data/backups/` of the task that is exported: another task's workspace is
//     refused, and so is the tasks root itself. A `*.jsonl` name is refused anywhere inside a workspace (the legacy `audit`
//     flags it): the extension of an export is `.ndjson`;
//   - the file itself is not a folder, a link or a device, and exists only with `force`;
//   - on Windows: no device name (`CON`, `NUL`, `COM1` ...), no stream (`name:stream`), no trailing dot or blank, no `\\.\` or `\\?\` prefix.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, unlinkSync, type ReadStream, type WriteStream } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { McsError, type ExportQuery, type ExportSummary, type ReaderMode } from '@mcs/shared';

import { claudeHomeOf } from '../ingest/transcripts/discovery.ts';
import { isBusyError, retryBusy } from '../platform/fsx.ts';
import { hostPlatform, pathsCaseInsensitive } from '../platform/host.ts';
import { workspacePath, type WorkspaceRef } from '../workspace/paths.ts';
import { withReader, type DataDeps } from './data.ts';
import type { OpContext } from './workspace.ts';

const LF = 10;
/** How long a rename that hits a Windows sharing violation is retried. */
const RENAME_BUDGET_MS = 3000;
/** Windows device names, with or without an extension (`NUL.ndjson` is the device too). */
const WINDOWS_DEVICES = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
const WINDOWS_BAD_CHARS = /[<>:"|?*]/;

function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function forbidden(message: string, hint: string): McsError {
  return new McsError('OUTPUT_PATH_FORBIDDEN', message, { hint });
}

function isInside(parent: string, child: string): boolean {
  const rel = pathsCaseInsensitive
    ? path.relative(parent.toLowerCase(), child.toLowerCase())
    : path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** True for a name that Windows treats as a device, a stream or something it silently renames. */
export function isWindowsReservedName(base: string): boolean {
  if (WINDOWS_BAD_CHARS.test(base) || Array.from(base).some((ch) => (ch.codePointAt(0) ?? 0) < 32)) return true;
  if (base.endsWith('.') || base.endsWith(' ')) return true;
  const stem = base.split('.')[0] ?? '';
  return WINDOWS_DEVICES.test(stem.trimEnd());
}

export interface ExportPathOptions {
  /** An existing regular file may be replaced. */
  readonly force?: boolean;
  /** Replaces the host platform (a test of the Windows rules on another system). */
  readonly platform?: NodeJS.Platform;
}

/** Where `exportToFile` will write, after the rules above. */
export interface ExportTarget {
  /** The final file: the real folder plus the name. */
  readonly file: string;
  /** `<file>.tmp`, in the same folder. */
  readonly tmp: string;
  /** The file exists and `force` allows replacing it. */
  readonly replaces: boolean;
}

/**
 * Applies the path rules to `out` for an export of the task `ws` and returns the target, or throws `OUTPUT_PATH_FORBIDDEN`
 * (the place or the name is refused), `OUTPUT_EXISTS` (the file exists and `force` is off) or `USAGE` (`out` names no file).
 */
export async function checkExportPath(
  ctx: OpContext,
  ws: WorkspaceRef,
  out: string,
  o: ExportPathOptions = {},
): Promise<ExportTarget> {
  const platform = o.platform ?? hostPlatform;
  if (out.trim() === '' || out.includes('\u0000')) {
    throw new McsError('USAGE', '--out must name a file', { hint: 'for example --out logs/export.ndjson' });
  }
  if (platform === 'win32' && /^[\\/]{2}[.?][\\/]/.test(out)) {
    throw forbidden(
      'a device or extended-length path is not accepted',
      'give an ordinary path such as C:\\exports\\x.ndjson',
    );
  }
  const wanted = path.resolve(out);
  const base = path.basename(wanted);
  if (base === '' || base === '.' || base === '..' || /[\\/]$/.test(out)) {
    throw new McsError('USAGE', '--out must name a file', { hint: 'for example --out logs/export.ndjson' });
  }
  if (platform === 'win32' && isWindowsReservedName(base)) {
    throw forbidden('that file name is reserved on Windows', 'choose another file name');
  }

  let dir: string;
  try {
    dir = await realpath(path.dirname(wanted));
  } catch {
    throw forbidden('the folder of --out does not exist', 'create the folder first, or choose another file');
  }

  const claudeHome = await realOrSelf(claudeHomeOf(ctx.env));
  if (isInside(claudeHome, dir)) {
    throw forbidden('an export is never written inside the Claude home', 'choose a file outside the .claude folder');
  }
  const tasksRoot = await realOrSelf(ctx.root);
  if (isInside(tasksRoot, dir)) {
    const allowed = [
      await realOrSelf(workspacePath(ws, 'logs')),
      await realOrSelf(path.join(ws.dir, 'data', 'backups')),
    ];
    if (!allowed.some((folder) => isInside(folder, dir))) {
      throw forbidden(
        'an export inside the tasks folder may only go to logs/ or data/backups/ of the task it describes',
        'choose a file outside the tasks folder, or the logs folder of this task',
      );
    }
    if (base.toLowerCase().endsWith('.jsonl')) {
      throw forbidden('a .jsonl file inside a task workspace fails the audit', 'use the .ndjson extension');
    }
  }

  const file = path.join(dir, base);
  let replaces = false;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw forbidden('--out is a link', 'choose a file that is not a link');
    if (info.isDirectory()) throw forbidden('--out is a folder', 'name a file inside it');
    if (!info.isFile()) throw forbidden('--out is not a regular file', 'choose another file name');
    if (o.force !== true) {
      throw new McsError('OUTPUT_EXISTS', `${base} already exists`, {
        hint: 'pass --force to replace it, or choose another file',
      });
    }
    replaces = true;
  } catch (error) {
    if (error instanceof McsError) throw error;
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
  return { file, tmp: `${file}.tmp`, replaces };
}

// ---- the write -------------------------------------------------------------------------------------------------------------------

export interface ExportFileOptions extends ExportPathOptions {
  /** A replacement for the sink or the readers (tests). */
  readonly deps?: DataDeps;
}

export interface ExportFileResult {
  readonly path: string;
  readonly mode: ReaderMode;
  /** `lines` and `bytes` are what the re-read of the file found, which equals what the reader reported. */
  readonly summary: ExportSummary;
  readonly replaced: boolean;
}

interface FileShape {
  readonly lines: number;
  readonly bytes: number;
  /** SHA-256 of every byte before the last line (the trailer). */
  readonly sha256: string;
}

/** The chunks of a read stream, checked to be bytes (a stream with an encoding would give text). */
async function* chunksOf(stream: ReadStream): AsyncGenerator<Uint8Array> {
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError('the export file was read as text');
    yield chunk;
  }
}

/** Reads `file` chunk by chunk: counts lines and bytes, finds where the last line starts, and hashes every byte before it. */
async function shapeOf(file: string): Promise<FileShape> {
  let lines = 0;
  let bytes = 0;
  let lastLf = -1;
  let prevLf = -1;
  for await (const chunk of chunksOf(createReadStream(file))) {
    let from = 0;
    for (;;) {
      const at = chunk.indexOf(LF, from);
      if (at < 0) break;
      lines += 1;
      prevLf = lastLf;
      lastLf = bytes + at;
      from = at + 1;
    }
    bytes += chunk.length;
  }
  const trailerStart = lines >= 2 ? prevLf + 1 : 0;
  const hash = createHash('sha256');
  if (trailerStart > 0) {
    for await (const chunk of chunksOf(createReadStream(file, { start: 0, end: trailerStart - 1 }))) {
      hash.update(chunk);
    }
  }
  return { lines, bytes, sha256: hash.digest('hex') };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flushes the file to disk: the data must be there before the rename makes it visible. */
async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Destroys the stream and waits until its file is closed (Windows cannot delete an open file). */
async function closeSink(sink: WriteStream): Promise<void> {
  if (sink.closed) return;
  await new Promise<void>((resolve) => {
    sink.once('close', () => {
      resolve();
    });
    sink.destroy();
  });
}

async function removeQuietly(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}

/**
 * Writes the export of `query` to `out` (the rules of `checkExportPath` first). The reader streams into `<out>.tmp`; the file is
 * synced, re-read and compared with the reader's summary, then renamed to `out`. On any failure the temp file is removed and the
 * final name is untouched. An exit of the process (Ctrl+C) also removes the temp file.
 */
export async function exportToFile(
  ctx: OpContext,
  ws: WorkspaceRef,
  query: ExportQuery,
  out: string,
  o: ExportFileOptions = {},
): Promise<ExportFileResult> {
  const target = await checkExportPath(ctx, ws, out, o);
  return withReader(ctx, ws.slug, o.deps ?? {}, async (reader) => {
    const sink = createWriteStream(target.tmp, { flags: 'wx', mode: 0o600 });
    try {
      await new Promise<void>((resolve, reject) => {
        sink.once('open', () => {
          resolve();
        });
        sink.once('error', reject);
      });
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
      throw new McsError('OUTPUT_EXISTS', `${path.basename(target.tmp)} already exists`, {
        hint: 'a leftover of an interrupted export; delete it, then run the export again',
      });
    }
    // a process that is ended while the export runs (Ctrl+C) never leaves the temp file behind
    const onExit = (): void => {
      try {
        unlinkSync(target.tmp);
      } catch {
        // already gone
      }
    };
    process.once('exit', onExit);
    try {
      const summary = await reader.exportTo(query, sink);
      await new Promise<void>((resolve, reject) => {
        sink.once('error', reject);
        sink.once('close', () => {
          resolve();
        });
        sink.end();
      });
      await syncFile(target.tmp);
      const shape = await shapeOf(target.tmp);
      if (shape.lines !== summary.lines || shape.bytes !== summary.bytes || shape.sha256 !== summary.sha256) {
        throw new McsError('INTERNAL', 'the export file does not match what the reader reported', {
          hint: 'nothing was written under the requested name; run the export again',
          details: { reason: 'export_mismatch' },
        });
      }
      // a file that appeared since the check is not ours to replace
      if (!target.replaces) {
        const appeared = await lstat(target.file).then(
          () => true,
          () => false,
        );
        if (appeared) throw new McsError('OUTPUT_EXISTS', `${path.basename(target.file)} already exists`);
      }
      await retryBusy(() => rename(target.tmp, target.file), {
        startedAt: performance.now(),
        budgetMs: RENAME_BUDGET_MS,
        now: () => performance.now(),
        sleep,
      }).catch((error: unknown) => {
        if (isBusyError(error)) {
          throw new McsError('INTERNAL', 'the export file could not be moved into place', {
            cause: error,
            hint: 'the target file is in use; close it and run the export again',
          });
        }
        throw error;
      });
      return { path: target.file, mode: reader.mode, summary, replaced: target.replaces };
    } catch (error) {
      await closeSink(sink);
      await removeQuietly(target.tmp);
      throw error;
    } finally {
      process.off('exit', onExit);
    }
  });
}
