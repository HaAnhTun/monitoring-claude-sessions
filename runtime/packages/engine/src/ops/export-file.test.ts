// `checkExportPath` and `exportToFile` (01 6.4, T-CLI-13): where an export may go, that the final name appears only by the rename of a
// verified temp file, and that a failed export leaves nothing behind. The reader is a scripted one; the temp tree holds two workspaces.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { McsError, type ExportQuery, type ExportSummary } from '@mcs/shared';
import { FakeClock, buildRepo, buildTaskWorkspace, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import type { Logger } from '../log/logger.ts';
import type { InstanceReader, ReaderOutput } from '../reader/open.ts';
import { completionTargetOf, exportQueryOf } from './data.ts';
import { checkExportPath, exportToFile, isWindowsReservedName } from './export-file.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

const makeTemp = useTempDirs();
const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

interface Setup {
  readonly ctx: OpContext;
  readonly root: string;
  readonly claudeHome: string;
  readonly outside: string;
  readonly logs: string;
  readonly otherLogs: string;
  readonly wsDir: string;
}

function setup(): Setup {
  const root = makeTemp('export-file').path;
  const { repo, tasksRoot } = buildRepo(path.join(root, 'repo'));
  const home = path.join(root, 'home');
  const claudeHome = path.join(home, '.claude');
  const outside = path.join(root, 'outside');
  for (const dir of [claudeHome, outside]) mkdirSync(dir, { recursive: true });
  const wsDir = buildTaskWorkspace(repo, { slug: 'demo', config: {}, instance: { slug: 'demo' } });
  const otherDir = buildTaskWorkspace(repo, { slug: 'other', config: {}, instance: { slug: 'other' } });
  const logs = path.join(wsDir, 'logs');
  const otherLogs = path.join(otherDir, 'logs');
  for (const dir of [logs, otherLogs, path.join(wsDir, 'data', 'backups')]) mkdirSync(dir, { recursive: true });
  const skillDir = defaultSkillDir();
  return {
    root,
    claudeHome,
    outside,
    logs,
    otherLogs,
    wsDir,
    ctx: {
      repo,
      root: tasksRoot,
      skillDir,
      runtimeDir: path.join(skillDir, 'runtime'),
      launcherPath: path.join(skillDir, 'scripts', 'mcs.mjs'),
      env: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: claudeHome, MCS_HOME: path.join(home, 'mcs') },
      clock: new FakeClock(Date.UTC(2026, 9, 25)),
      log: silent,
    },
  };
}

/** True when this host lets a process create a symbolic link to a file. */
function canLinkFiles(): boolean {
  const dir = makeTemp('export-file-probe');
  try {
    writeFileSync(path.join(dir.path, 'a'), 'a');
    symlinkSync(path.join(dir.path, 'a'), path.join(dir.path, 'b'), 'file');
    return true;
  } catch {
    return false;
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McsError) return error.code;
    throw error;
  }
  return 'no error';
}

describe('isWindowsReservedName', () => {
  it('flags devices (with or without an extension), streams and trailing dots or blanks', () => {
    for (const name of [
      'CON',
      'nul.ndjson',
      'Com1.txt',
      'LPT9',
      'aux.x.y',
      'a:b.ndjson',
      'x.ndjson.',
      'x ',
      'a|b',
      'q?',
    ]) {
      expect(isWindowsReservedName(name), name).toBe(true);
    }
    for (const name of ['export.ndjson', 'console.ndjson', 'com10.ndjson', 'null.ndjson', 'x.jsonl']) {
      expect(isWindowsReservedName(name), name).toBe(false);
    }
  });
});

describe('checkExportPath', () => {
  it('accepts a .ndjson file in logs/ and in data/backups/ of the exported task', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const target = await checkExportPath(s.ctx, ws, path.join(s.logs, 'x.ndjson'));
    expect(path.basename(target.file)).toBe('x.ndjson');
    expect(target.tmp).toBe(`${target.file}.tmp`);
    expect(target.replaces).toBe(false);
    await checkExportPath(s.ctx, ws, path.join(s.wsDir, 'data', 'backups', 'x.ndjson'));
  });

  it('accepts a file outside every workspace, whatever its extension', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    await checkExportPath(s.ctx, ws, path.join(s.outside, 'x.jsonl'));
    await checkExportPath(s.ctx, ws, path.join(s.outside, 'x.ndjson'));
  });

  it('refuses a .jsonl name inside a workspace', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.logs, 'x.jsonl')))).toBe('OUTPUT_PATH_FORBIDDEN');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.logs, 'X.JSONL')))).toBe('OUTPUT_PATH_FORBIDDEN');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.otherLogs, 'x.jsonl')))).toBe('OUTPUT_PATH_FORBIDDEN');
  });

  it('refuses the rest of the workspace, another workspace, and the tasks folder itself', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    for (const dir of [s.wsDir, path.join(s.wsDir, 'data'), path.join(s.wsDir, 'audit'), s.otherLogs, s.ctx.root]) {
      mkdirSync(dir, { recursive: true });
      expect(await codeOf(checkExportPath(s.ctx, ws, path.join(dir, 'x.ndjson'))), dir).toBe('OUTPUT_PATH_FORBIDDEN');
    }
  });

  it('refuses the Claude home', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.claudeHome, 'x.ndjson')))).toBe('OUTPUT_PATH_FORBIDDEN');
  });

  it('refuses a missing folder, a folder as the file, an empty name and a trailing separator', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.outside, 'nope', 'x.ndjson')))).toBe(
      'OUTPUT_PATH_FORBIDDEN',
    );
    mkdirSync(path.join(s.outside, 'dir.ndjson'));
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.outside, 'dir.ndjson'), { force: true }))).toBe(
      'OUTPUT_PATH_FORBIDDEN',
    );
    expect(await codeOf(checkExportPath(s.ctx, ws, ''))).toBe('USAGE');
    expect(await codeOf(checkExportPath(s.ctx, ws, `${s.outside}${path.sep}`))).toBe('USAGE');
  });

  it('judges the real folder: a link to a forbidden folder is that folder', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const toOther = path.join(s.outside, 'to-other');
    const toHome = path.join(s.outside, 'to-home');
    symlinkSync(s.otherLogs, toOther, 'junction');
    symlinkSync(s.claudeHome, toHome, 'junction');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(toOther, 'x.ndjson')))).toBe('OUTPUT_PATH_FORBIDDEN');
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(toHome, 'x.ndjson')))).toBe('OUTPUT_PATH_FORBIDDEN');
    // a link to this task's own logs folder is the logs folder, so it is fine
    const toLogs = path.join(s.outside, 'to-logs');
    symlinkSync(s.logs, toLogs, 'junction');
    await checkExportPath(s.ctx, ws, path.join(toLogs, 'x.ndjson'));
    // and `..` cannot climb out of logs/
    expect(await codeOf(checkExportPath(s.ctx, ws, path.join(s.logs, '..', 'x.ndjson')))).toBe('OUTPUT_PATH_FORBIDDEN');
  });

  it('refuses an existing file without force', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const file = path.join(s.outside, 'x.ndjson');
    writeFileSync(file, 'old');
    expect(await codeOf(checkExportPath(s.ctx, ws, file))).toBe('OUTPUT_EXISTS');
    expect((await checkExportPath(s.ctx, ws, file, { force: true })).replaces).toBe(true);
  });

  // creating a file link needs a privilege on Windows (a folder junction does not); the probe tells whether this host allows it
  it.skipIf(!canLinkFiles())('refuses a link as the file, even with force', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const file = path.join(s.outside, 'x.ndjson');
    writeFileSync(file, 'old');
    const link = path.join(s.outside, 'link.ndjson');
    symlinkSync(file, link, 'file');
    expect(await codeOf(checkExportPath(s.ctx, ws, link, { force: true }))).toBe('OUTPUT_PATH_FORBIDDEN');
  });

  it('applies the Windows rules when asked to', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    for (const name of ['CON.ndjson', 'nul', 'a:stream.ndjson', 'x.ndjson.']) {
      const out = path.join(s.outside, name);
      expect(await codeOf(checkExportPath(s.ctx, ws, out, { platform: 'win32' })), name).toBe('OUTPUT_PATH_FORBIDDEN');
    }
    expect(await codeOf(checkExportPath(s.ctx, ws, '\\\\.\\pipe\\x', { platform: 'win32' }))).toBe(
      'OUTPUT_PATH_FORBIDDEN',
    );
    expect(await codeOf(checkExportPath(s.ctx, ws, '//?/C:/x.ndjson', { platform: 'win32' }))).toBe(
      'OUTPUT_PATH_FORBIDDEN',
    );
  });
});

// ---- exportToFile ----------------------------------------------------------------------------------------------------------------

const QUERY: ExportQuery = {};

function lineOf(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** A reader whose `exportTo` writes a header, `records` record lines and a trailer, and reports the true summary. */
function scriptedReader(
  records: number,
  o: { fail?: boolean; lie?: Partial<ExportSummary>; chunks?: number } = {},
): InstanceReader {
  const reader = {
    mode: 'db',
    instanceId: 'x',
    exportTo: async (_q: ExportQuery, out: ReaderOutput): Promise<ExportSummary> => {
      const head = lineOf({ type: 'header', format: 'mcs.export/1' });
      const body = Array.from({ length: records }, (_unused, i) => lineOf({ type: 'session', data: { i } })).join('');
      const before = head + body;
      const sha256 = createHash('sha256').update(before).digest('hex');
      const trailer = lineOf({ type: 'trailer', counts: { sessions: records }, sha256 });
      out.write(before);
      if (o.fail === true) throw new McsError('API_ERROR', 'the connection ended');
      out.write(trailer);
      await Promise.resolve();
      return {
        lines: records + 2,
        bytes: Buffer.byteLength(before + trailer),
        sha256,
        counts: { sessions: records },
        includeContent: false,
        ...o.lie,
      };
    },
    close: () => Promise.resolve(),
  };
  return reader as unknown as InstanceReader;
}

function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

describe('exportToFile', () => {
  it('writes the file by rename and reports what the re-read found', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const out = path.join(s.logs, 'export.ndjson');
    const result = await exportToFile(s.ctx, ws, QUERY, out, {
      deps: { openReader: () => Promise.resolve(scriptedReader(500)) },
    });
    expect(path.basename(result.path)).toBe('export.ndjson');
    expect(result.summary.lines).toBe(502);
    expect(result.replaced).toBe(false);
    const text = readFileSync(out, 'utf8');
    expect(text.split('\n').length - 1).toBe(502);
    expect(leftovers(s.logs)).toEqual([]);
  });

  it('replaces an existing file only with force, and keeps it when the export fails', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const out = path.join(s.outside, 'x.ndjson');
    writeFileSync(out, 'old');
    const deps = { openReader: () => Promise.resolve(scriptedReader(3)) };
    expect(await codeOf(exportToFile(s.ctx, ws, QUERY, out, { deps }))).toBe('OUTPUT_EXISTS');
    expect(readFileSync(out, 'utf8')).toBe('old');
    const failing = { openReader: () => Promise.resolve(scriptedReader(3, { fail: true })) };
    expect(await codeOf(exportToFile(s.ctx, ws, QUERY, out, { deps: failing, force: true }))).toBe('API_ERROR');
    expect(readFileSync(out, 'utf8')).toBe('old');
    expect(leftovers(s.outside)).toEqual([]);
    const done = await exportToFile(s.ctx, ws, QUERY, out, { deps, force: true });
    expect(done.replaced).toBe(true);
    expect(readFileSync(out, 'utf8').split('\n').length - 1).toBe(5);
  });

  it('leaves no file at all when the reader fails', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const out = path.join(s.outside, 'y.ndjson');
    const failing = { openReader: () => Promise.resolve(scriptedReader(10, { fail: true })) };
    expect(await codeOf(exportToFile(s.ctx, ws, QUERY, out, { deps: failing }))).toBe('API_ERROR');
    expect(readdirSync(s.outside)).toEqual([]);
  });

  it('refuses a file whose re-read does not match the summary (lines, bytes or checksum)', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const out = path.join(s.outside, 'z.ndjson');
    const lies: Partial<ExportSummary>[] = [{ lines: 99 }, { bytes: 1 }, { sha256: 'f'.repeat(64) }];
    for (const lie of lies) {
      const deps = { openReader: () => Promise.resolve(scriptedReader(4, { lie })) };
      expect(await codeOf(exportToFile(s.ctx, ws, QUERY, out, { deps })), JSON.stringify(lie)).toBe('INTERNAL');
      expect(existsSync(out)).toBe(false);
      expect(readdirSync(s.outside)).toEqual([]);
    }
  });

  it('does not touch a leftover temp file of an earlier interrupted export', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    const out = path.join(s.outside, 'w.ndjson');
    writeFileSync(`${out}.tmp`, 'leftover');
    const deps = { openReader: () => Promise.resolve(scriptedReader(1)) };
    expect(await codeOf(exportToFile(s.ctx, ws, QUERY, out, { deps }))).toBe('OUTPUT_EXISTS');
    expect(readFileSync(`${out}.tmp`, 'utf8')).toBe('leftover');
    expect(existsSync(out)).toBe(false);
  });

  it('applies the path rules before it opens a reader', async () => {
    const s = setup();
    const ws = await openWorkspace(s.ctx, 'demo');
    let opened = 0;
    const deps = {
      openReader: () => {
        opened += 1;
        return Promise.resolve(scriptedReader(1));
      },
    };
    expect(await codeOf(exportToFile(s.ctx, ws, QUERY, path.join(s.logs, 'x.jsonl'), { deps }))).toBe(
      'OUTPUT_PATH_FORBIDDEN',
    );
    expect(opened).toBe(0);
  });
});

// ---- the flags as a query and a target (ops.data) --------------------------------------------------------------------------------------

describe('exportQueryOf', () => {
  it('turns the flags into the query of the route and leaves content off unless it is asked for', () => {
    expect(exportQueryOf({})).toEqual({});
    expect(exportQueryOf({ since: '7d', include: 'sessions, events', redaction: 'strict' })).toEqual({
      range: '7d',
      include: ['sessions', 'events'],
      redaction: 'strict',
    });
    expect(exportQueryOf({ since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' })).toMatchObject({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    });
    expect(exportQueryOf({ includeContent: true }).includeContent).toBe(true);
    expect(exportQueryOf({ includeContent: false, redaction: 'standard' }).includeContent).toBeUndefined();
  });

  it('refuses content with strict redaction and names the flag of every value that does not parse', () => {
    const message = (flags: Parameters<typeof exportQueryOf>[0]): string => {
      try {
        exportQueryOf(flags);
      } catch (error) {
        if (error instanceof McsError) return `${error.code}: ${error.message}`;
        throw error;
      }
      return 'no error';
    };
    expect(message({ redaction: 'strict', includeContent: true })).toMatch(/^USAGE: --include-content/);
    expect(message({ redaction: 'loose' })).toBe('USAGE: --redaction expects standard or strict');
    expect(message({ include: 'nothing' })).toMatch(/^USAGE: --include expects a comma-separated list of sessions/);
    expect(message({ session: 'nope' })).toMatch(/^USAGE: --session expects /);
    expect(message({ since: 'yesterday' })).toMatch(/^USAGE: --since expects /);
    expect(message({ until: '2026-10-02T00:00:00Z' })).toBe('USAGE: --until needs --since');
  });
});

describe('completionTargetOf', () => {
  it('needs exactly one selector; the empty attempt part is a selector', () => {
    expect(completionTargetOf({ session: 'AAAAAAAA-0000-4000-8000-000000000001' })).toEqual({
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    });
    expect(completionTargetOf({ label: 'build step A' })).toEqual({ label: 'build step A' });
    expect(completionTargetOf({ attempt: '' })).toEqual({ attemptPart: '' });
    for (const flags of [{}, { session: 'x', label: 'y' }, { label: 'y', attempt: 'A' }]) {
      expect(() => completionTargetOf(flags), JSON.stringify(flags)).toThrow(McsError);
    }
  });
});
