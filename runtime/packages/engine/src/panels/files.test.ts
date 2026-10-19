import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PanelResponseSchema } from '@mcs/shared';
import { FakeClock, FIXTURE_EPOCH_MS, useTempDirs, waitFor } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { tailLines } from '../platform/fsx.ts';
import { canonicalPath } from '../platform/paths.ts';
import { createErrorRing } from '../runtime/error-ring.ts';
import { LOG_CAPPED_MESSAGE } from './constants.ts';
import { createFilesSampler, type FilesIo, type FilesSamplerDeps } from './files.ts';
import { panelStatus } from './source-cache.ts';

const makeTemp = useTempDirs();

/** Line separators that Python `splitlines` honours, built from code points so that no tool can lose them. */
const LS = String.fromCodePoint(0x2028);
const NEL = String.fromCodePoint(0x85);

/** A fresh empty folder: the temp root itself holds the testkit's FIXTURE.md marker. */
function freshRepo(): string {
  const dir = path.join(makeTemp('files-panel').path, 'repo');
  mkdirSync(dir);
  return dir;
}

function write(repo: string, rel: string, text: string, mtime?: Date): string {
  const file = path.join(repo, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mtime !== undefined) utimesSync(file, mtime, mtime);
  return file;
}

function make(repo: string, over: Partial<FilesSamplerDeps> = {}) {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const errors = createErrorRing(clock);
  const files = createFilesSampler({
    repoDir: repo,
    ledger: null,
    chainLog: null,
    stopFile: null,
    liveLogGlobs: [],
    clock,
    errors,
    ...over,
  });
  return { clock, errors, files };
}

const lines = (n: number, make_: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => make_(i)).join('\n') + '\n';

describe('stop file', () => {
  it('is true when the file is present, false when absent', async () => {
    const repo = freshRepo();
    write(repo, 'STOP', '');
    const present = await make(repo, { stopFile: 'STOP' }).files.stopFile();
    expect(present.data).toBe(true);
    expect(present.sources).toEqual([
      { source: 'stopFile', status: 'ok', sampledAt: '2026-01-01T00:00:00.000Z', message: null },
    ]);
    const absent = await make(repo, { stopFile: 'NOPE' }).files.stopFile();
    expect(absent.data).toBe(false);
    expect(absent.sources[0]?.status).toBe('ok');
  });

  it('is false and disabled when not configured', async () => {
    const sample = await make(freshRepo()).files.stopFile();
    expect(sample.data).toBe(false);
    expect(sample.sources).toEqual([{ source: 'stopFile', status: 'disabled', sampledAt: null, message: null }]);
  });

  it('takes an absolute path as it is and never throws for a strange one', async () => {
    const repo = freshRepo();
    const elsewhere = write(path.dirname(repo), 'outside-stop', '');
    expect((await make(repo, { stopFile: elsewhere }).files.stopFile()).data).toBe(true);
    expect((await make(repo, { stopFile: 'bad\u0000name' }).files.stopFile()).data).toBe(false);
  });

  it('notices a created file after the 2 s ttl', async () => {
    const repo = freshRepo();
    const { files, clock } = make(repo, { stopFile: 'STOP' });
    expect((await files.stopFile()).data).toBe(false);
    write(repo, 'STOP', '');
    expect((await files.stopFile()).data).toBe(false);
    clock.advance(2000);
    await files.stopFile(); // stale value, starts the refresh
    await waitFor(async () => (await files.stopFile()).data);
  });
});

describe('ledger', () => {
  it('keeps the lines that start with a pipe among the last 30 lines', async () => {
    const repo = freshRepo();
    const text = lines(45, (i) => (i % 5 === 0 ? `note ${String(i)}` : `| row ${String(i)} |`));
    write(repo, 'ledger.md', text);
    const sample = await make(repo, { ledger: 'ledger.md' }).files.ledger();
    // the last 30 lines are rows 15..44; rows 15, 20, ... 40 are notes
    const expected = Array.from({ length: 30 }, (_, k) => k + 15)
      .filter((i) => i % 5 !== 0)
      .map((i) => `| row ${String(i)} |`);
    expect(sample.data?.lines).toEqual(expected);
    expect(sample.data).toMatchObject({ file: 'ledger.md', exists: true });
    expect(sample.data?.sizeBytes).toBe(Buffer.byteLength(text));
    expect(sample.data?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(sample.sources[0]).toMatchObject({ source: 'ledger', status: 'ok' });
  });

  it('keeps exactly 30 lines of a long all-pipe ledger', async () => {
    const repo = freshRepo();
    write(
      repo,
      'ledger.md',
      lines(100, (i) => `| ${String(i)} |`),
    );
    const sample = await make(repo, { ledger: 'ledger.md' }).files.ledger();
    expect(sample.data?.lines).toHaveLength(30);
    expect(sample.data?.lines[0]).toBe('| 70 |');
    expect(sample.data?.lines[29]).toBe('| 99 |');
  });

  it('reads CRLF files without carriage returns in the lines', async () => {
    const repo = freshRepo();
    write(repo, 'ledger.md', '| a |\r\n| b |\r\n');
    expect((await make(repo, { ledger: 'ledger.md' }).files.ledger()).data?.lines).toEqual(['| a |', '| b |']);
  });

  it('is disabled with empty data when not configured', async () => {
    const sample = await make(freshRepo()).files.ledger();
    expect(sample.data).toEqual({ lines: [], file: null, exists: false, sizeBytes: null, modifiedAt: null });
    expect(sample.sources).toEqual([{ source: 'ledger', status: 'disabled', sampledAt: null, message: null }]);
    expect(panelStatus(sample.sources, true)).toBe('ok');
  });

  it('is unavailable with empty data when the file is missing', async () => {
    const sample = await make(freshRepo(), { ledger: 'missing.md' }).files.ledger();
    expect(sample.data).toEqual({ lines: [], file: 'missing.md', exists: false, sizeBytes: null, modifiedAt: null });
    expect(sample.sources[0]).toMatchObject({
      source: 'ledger',
      status: 'unavailable',
      message: 'the ledger file was not found',
    });
    expect(panelStatus(sample.sources, true)).toBe('partial');
  });

  it('is unavailable when the configured path is a directory', async () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'a-folder'));
    const sample = await make(repo, { ledger: 'a-folder' }).files.ledger();
    expect(sample.data).toMatchObject({ lines: [], exists: false });
    expect(sample.sources[0]).toMatchObject({
      status: 'unavailable',
      message: 'the ledger path is a folder, not a file',
    });
  });

  it('resolves a relative path with .. against the repository and reads it as written', async () => {
    const repo = freshRepo();
    write(path.dirname(repo), 'shared-ledger.md', '| outside |\n');
    const sample = await make(repo, { ledger: '../shared-ledger.md' }).files.ledger();
    expect(sample.data).toMatchObject({ lines: ['| outside |'], file: '../shared-ledger.md', exists: true });
  });

  it('turns a path the file system rejects into an error state instead of throwing', async () => {
    const sample = await make(freshRepo(), { ledger: 'bad\u0000name' }).files.ledger();
    expect(sample.sources[0]?.status).toBe('error');
    expect(sample.data).toBeNull();
  });

  it('shows the file a second time without reading it inside the ttl, and again after it', async () => {
    const repo = freshRepo();
    write(repo, 'ledger.md', '| one |\n');
    const { files, clock } = make(repo, { ledger: 'ledger.md' });
    expect((await files.ledger()).data?.lines).toEqual(['| one |']);
    write(repo, 'ledger.md', '| one |\n| two |\n');
    clock.advance(4999);
    expect((await files.ledger()).data?.lines).toEqual(['| one |']);
    clock.advance(1);
    await files.ledger();
    await waitFor(async () => (await files.ledger()).data?.lines.length === 2);
    expect((await files.ledger()).data?.lines).toEqual(['| one |', '| two |']);
  });

  it('serves empty data once the file disappears instead of the old lines', async () => {
    const repo = freshRepo();
    const file = write(repo, 'ledger.md', '| one |\n');
    const { files, clock } = make(repo, { ledger: 'ledger.md' });
    await files.ledger();
    rmSync(file);
    clock.advance(5000);
    await files.ledger();
    await waitFor(async () => (await files.ledger()).sources[0]?.status === 'unavailable');
    const sample = await files.ledger();
    expect(sample.data).toMatchObject({ lines: [], exists: false });
    expect(sample.sources[0]?.status).toBe('unavailable');
  });
});

describe('chain log', () => {
  it('keeps the last 10 lines whatever they start with', async () => {
    const repo = freshRepo();
    write(
      repo,
      'chain.log',
      lines(25, (i) => `line ${String(i)}`),
    );
    const sample = await make(repo, { chainLog: 'chain.log' }).files.chainLog();
    expect(sample.data?.lines).toEqual(Array.from({ length: 10 }, (_, k) => `line ${String(k + 15)}`));
    expect(sample.data).toMatchObject({ file: 'chain.log', exists: true });
    expect(sample.sources[0]?.source).toBe('chainLog');
  });

  it('returns exactly what tailLines gives', async () => {
    const repo = freshRepo();
    const file = write(repo, 'chain.log', `${lines(12, (i) => `x${String(i)}${LS}y${String(i)}`)}\r\nlast${NEL}after`);
    const sample = await make(repo, { chainLog: 'chain.log' }).files.chainLog();
    expect(sample.data?.lines).toEqual(await tailLines(file, 10));
  });

  it('is disabled when not configured, unavailable when missing, and keeps CRLF out of the lines', async () => {
    const repo = freshRepo();
    const none = await make(repo).files.chainLog();
    expect(none.sources[0]).toMatchObject({ source: 'chainLog', status: 'disabled' });
    expect(none.data).toEqual({ lines: [], file: null, exists: false, sizeBytes: null, modifiedAt: null });
    expect((await make(repo, { chainLog: 'nope.log' }).files.chainLog()).sources[0]?.status).toBe('unavailable');
    write(repo, 'crlf.log', 'a\r\nb\r\n');
    expect((await make(repo, { chainLog: 'crlf.log' }).files.chainLog()).data?.lines).toEqual(['a', 'b']);
  });

  it('is unavailable for a directory', async () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'dir.log'));
    const sample = await make(repo, { chainLog: 'dir.log' }).files.chainLog();
    expect(sample.sources[0]).toMatchObject({
      status: 'unavailable',
      message: 'the chain log path is a folder, not a file',
    });
  });
});

describe('live logs', () => {
  const NOW = FIXTURE_EPOCH_MS;
  const ago = (seconds: number): Date => new Date(NOW - seconds * 1000);

  it('shows the newest four of six files, tails for the first two only, lines clipped to 220 code points', async () => {
    const repo = freshRepo();
    const emoji = '\u{1F600}';
    for (let i = 0; i < 6; i += 1) {
      write(
        repo,
        `logs/f${String(i)}.log`,
        lines(20, (n) => `f${String(i)} line ${String(n)} ${emoji.repeat(300)}`),
        ago(100 * (i + 1)),
      );
    }
    const sample = await make(repo, { liveLogGlobs: ['logs/*.log'] }).files.logs();
    const files = sample.data?.files ?? [];
    expect(files.map((f) => f.name)).toEqual(['f0.log', 'f1.log', 'f2.log', 'f3.log']);
    expect(sample.data?.matchedFiles).toBe(6);
    expect(files[0]?.tail).toHaveLength(16);
    expect(files[0]?.tail[15]).toMatch(/^f0 line 19 /);
    expect(Array.from(files[0]?.tail[0] ?? '')).toHaveLength(220);
    expect(files[1]?.tail).toHaveLength(16);
    expect(files[2]?.tail).toEqual([]);
    expect(files[3]?.tail).toEqual([]);
    expect(files[0]).toMatchObject({ relPath: 'logs/f0.log', ageS: 100 });
    expect(files[3]?.ageS).toBe(400);
    expect(files[0]?.sizeBytes).toBeGreaterThan(0);
    expect(files[0]?.modifiedAt).toBe(ago(100).toISOString());
    expect(sample.sources[0]).toMatchObject({ source: 'logs', status: 'ok', message: null });
    expect(
      PanelResponseSchema.safeParse({
        key: 'logs',
        status: 'ok',
        generatedAt: '2026-01-01T00:00:00.000Z',
        sources: sample.sources,
        data: sample.data,
      }).success,
    ).toBe(true);
  });

  it('never cuts a surrogate pair when it clips', async () => {
    const repo = freshRepo();
    write(repo, 'a.log', `${'a'.repeat(219)}\u{1F600}tail\n`);
    const sample = await make(repo, { liveLogGlobs: ['*.log'] }).files.logs();
    const line = sample.data?.files[0]?.tail[0] ?? '';
    expect(Array.from(line)).toHaveLength(220);
    expect(line.endsWith('\u{1F600}')).toBe(true);
  });

  it('skips a file that vanished between the glob and the stat', async () => {
    const repo = freshRepo();
    const a = write(repo, 'a.log', 'a\n', ago(10));
    const b = write(repo, 'b.log', 'b\n', ago(20));
    const io: FilesIo = {
      stat: async (file) => {
        if (file === canonicalPath(b)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        const { stat } = await import('node:fs/promises');
        const s = await stat(file);
        return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
      },
      tailLines,
      globFiles: () => Promise.resolve({ files: [a, b], truncated: false }),
    };
    const sample = await make(repo, { liveLogGlobs: ['*.log'], io }).files.logs();
    expect(sample.data?.files.map((f) => f.name)).toEqual(['a.log']);
    expect(sample.data?.matchedFiles).toBe(1);
    expect(sample.sources[0]?.status).toBe('ok');
  });

  it('recurses with ** and leaves out dotfiles', async () => {
    const repo = freshRepo();
    write(repo, 'logs/a.log', 'a\n', ago(1));
    write(repo, 'logs/deep/er/b.log', 'b\n', ago(2));
    write(repo, 'logs/.hidden.log', 'h\n', ago(3));
    write(repo, 'logs/.dot/c.log', 'c\n', ago(4));
    const sample = await make(repo, { liveLogGlobs: ['logs/**/*.log'] }).files.logs();
    expect(sample.data?.files.map((f) => f.relPath)).toEqual(['logs/a.log', 'logs/deep/er/b.log']);
  });

  it('lists a file matched by two patterns once', async () => {
    const repo = freshRepo();
    write(repo, 'logs/a.log', 'a\n');
    const sample = await make(repo, { liveLogGlobs: ['logs/*.log', 'logs/a.*', '**/a.log'] }).files.logs();
    expect(sample.data?.files).toHaveLength(1);
    expect(sample.data?.matchedFiles).toBe(1);
  });

  it('breaks a tie of modification times by path', async () => {
    const repo = freshRepo();
    const same = ago(50);
    write(repo, 'z.log', 'z\n', same);
    write(repo, 'a.log', 'a\n', same);
    write(repo, 'm.log', 'm\n', same);
    const sample = await make(repo, { liveLogGlobs: ['*.log'] }).files.logs();
    expect(sample.data?.files.map((f) => f.name)).toEqual(['a.log', 'm.log', 'z.log']);
  });

  it('reports 501 matching files with the capped message', async () => {
    const repo = freshRepo();
    for (let i = 0; i < 501; i += 1) write(repo, `many/f${String(i).padStart(3, '0')}.log`, 'x\n');
    const sample = await make(repo, { liveLogGlobs: ['many/*.log'] }).files.logs();
    expect(sample.data?.matchedFiles).toBe(500);
    expect(sample.data?.files).toHaveLength(4);
    expect(sample.sources[0]).toMatchObject({ status: 'ok', message: LOG_CAPPED_MESSAGE });
    expect(LOG_CAPPED_MESSAGE).toBe('more than 500 files match live_log_globs; showing the newest of the first 500');
  }, 30_000);

  it('is disabled with empty data when there is no glob', async () => {
    const sample = await make(freshRepo()).files.logs();
    expect(sample.data).toEqual({ files: [], matchedFiles: 0 });
    expect(sample.sources).toEqual([{ source: 'logs', status: 'disabled', sampledAt: null, message: null }]);
  });

  it('is ok with no files when the globs match nothing', async () => {
    const sample = await make(freshRepo(), { liveLogGlobs: ['nothing/*.log'] }).files.logs();
    expect(sample.data).toEqual({ files: [], matchedFiles: 0 });
    expect(sample.sources[0]?.status).toBe('ok');
  });

  it('shows a path outside the repository as an absolute path with forward slashes', async () => {
    const repo = freshRepo();
    const outside = write(path.dirname(repo), 'outside/x.log', 'x\n');
    const sample = await make(repo, { liveLogGlobs: [outside] }).files.logs();
    const rel = sample.data?.files[0]?.relPath ?? '';
    expect(rel).not.toContain('\\');
    expect(path.isAbsolute(rel)).toBe(true);
  });

  it('does not list a directory that matches a pattern', async () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'dir.log'));
    write(repo, 'file.log', 'x\n');
    const sample = await make(repo, { liveLogGlobs: ['*.log'] }).files.logs();
    expect(sample.data?.files.map((f) => f.name)).toEqual(['file.log']);
  });

  it('turns a failing glob into an error state without data', async () => {
    const io: FilesIo = {
      stat: () => Promise.reject(new Error('unused')),
      tailLines: () => Promise.resolve([]),
      globFiles: () => Promise.reject(new Error('glob exploded\nsecond line')),
    };
    const sample = await make(freshRepo(), { liveLogGlobs: ['*.log'], io }).files.logs();
    expect(sample.data).toBeNull();
    expect(sample.sources[0]).toMatchObject({ status: 'error', message: 'glob exploded' });
    expect(panelStatus(sample.sources, false)).toBe('error');
  });

  it('keeps a symbolic link to a file as a file when the platform allows links', async () => {
    const repo = freshRepo();
    const target = write(repo, 'real.txt', 'x\n');
    try {
      symlinkSync(target, path.join(repo, 'link.log'));
    } catch {
      return; // links need a privilege on Windows; the other tests cover the listing
    }
    const sample = await make(repo, { liveLogGlobs: ['*.log'] }).files.logs();
    expect(sample.data?.files).toHaveLength(1);
  });
});

describe('stats and abort', () => {
  it('counts only the sources that were read', async () => {
    const repo = freshRepo();
    write(repo, 'ledger.md', '| a |\n');
    const { files } = make(repo, { ledger: 'ledger.md', chainLog: 'chain.log' });
    expect(files.stats()).toEqual({});
    await files.ledger();
    expect(Object.keys(files.stats())).toEqual(['ledger']);
    expect(files.stats().ledger).toMatchObject({ refreshes: 1, failures: 0, lastStatus: 'ok' });
    files.abort();
  });
});
