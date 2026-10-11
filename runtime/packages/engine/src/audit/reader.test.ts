// `entriesBetween` (01 7.1, I-19): the window of audit references of a session, over legacy-written and Node-written
// files. T-AU-06.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isoSecondsZ } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import { resolveWorkspace, type WorkspaceRef } from '../workspace/paths.ts';
import { entriesBetween, type AuditRef } from './reader.ts';
import { appendChange, appendDecision } from './writer.ts';

const makeTemp = useTempDirs();
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/legacy-workspace/', import.meta.url));
const BOM = String.fromCodePoint(0xfeff);
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function freshWorkspace(): WorkspaceRef {
  const root = path.join(makeTemp('audit-reader').path, 'tasks');
  const dir = path.join(root, 'demo');
  mkdirSync(path.join(dir, 'audit'), { recursive: true });
  writeFileSync(path.join(dir, 'task.json'), '{}');
  return resolveWorkspace(root, 'demo');
}

function put(ws: WorkspaceRef, file: 'changes' | 'decisions', text: string): void {
  writeFileSync(path.join(ws.dir, 'audit', `${file}.md`), text);
}

function ts(offsetSeconds: number): string {
  return isoSecondsZ(T0 + offsetSeconds * 1000);
}

function change(offsetSeconds: number, action: string, summary: string): string {
  return `## ${ts(offsetSeconds)} | ${action}\n- Summary: ${summary}\n- Reason: r\n- Files changed: none\n- Validation: v\n- Outcome: o\n- Unresolved: none\n\n`;
}

function decision(offsetSeconds: number, title: string, text: string): string {
  return `## ${ts(offsetSeconds)} | ${title}\n- Decision: ${text}\n- Rejected alternatives: none recorded\n\n`;
}

function iso(offsetSeconds: number): string {
  return `${ts(offsetSeconds).slice(0, -1)}.000Z`;
}

const ALL = (): [number, number] => [0, Date.UTC(2100, 0, 1)];

describe('entriesBetween', () => {
  it('returns the references of both files, newest first, with ISO milliseconds', async () => {
    const ws = freshWorkspace();
    put(ws, 'changes', `# Changes\n\n${change(10, 'init-task', 'first')}${change(30, 'configure', 'third')}`);
    put(ws, 'decisions', `# Decisions\n\n${decision(20, 'Keep it short', 'second')}`);
    const refs = await entriesBetween(ws, ...ALL(), 10);
    expect(refs).toEqual<AuditRef[]>([
      { file: 'changes', at: iso(30), title: 'configure', summary: 'third' },
      { file: 'decisions', at: iso(20), title: 'Keep it short', summary: 'second' },
      { file: 'changes', at: iso(10), title: 'init-task', summary: 'first' },
    ]);
  });

  it('the window bounds are inclusive on both sides', async () => {
    const ws = freshWorkspace();
    put(ws, 'changes', `# Changes\n\n${change(10, 'a', '10')}${change(20, 'a', '20')}${change(30, 'a', '30')}`);
    const at = (from: number, to: number): Promise<string[]> =>
      entriesBetween(ws, T0 + from * 1000, T0 + to * 1000, 10).then((refs) => refs.map((r) => r.summary));
    expect(await at(10, 30)).toEqual(['30', '20', '10']);
    expect(await at(11, 29)).toEqual(['20']);
    expect(await at(20, 20)).toEqual(['20']);
    expect(await at(21, 29)).toEqual([]);
    expect(await at(30, 10)).toEqual([]);
  });

  it('fractional bounds compare against whole-second timestamps', async () => {
    const ws = freshWorkspace();
    put(ws, 'changes', `# Changes\n\n${change(10, 'a', 'x')}`);
    expect(await entriesBetween(ws, T0 + 10_000 - 0.5, T0 + 10_000 + 0.5, 5)).toHaveLength(1);
    expect(await entriesBetween(ws, T0 + 10_000 + 0.5, T0 + 20_000, 5)).toHaveLength(0);
  });

  it('applies the limit after merging and sorting', async () => {
    const ws = freshWorkspace();
    put(ws, 'changes', `# Changes\n\n${change(1, 'a', 'c1')}${change(3, 'a', 'c3')}${change(5, 'a', 'c5')}`);
    put(ws, 'decisions', `# Decisions\n\n${decision(2, 'd', 'd2')}${decision(4, 'd', 'd4')}`);
    expect((await entriesBetween(ws, ...ALL(), 3)).map((r) => r.summary)).toEqual(['c5', 'd4', 'c3']);
    expect(await entriesBetween(ws, ...ALL(), 0)).toEqual([]);
    expect((await entriesBetween(ws, ...ALL(), 100)).map((r) => r.summary)).toEqual(['c5', 'd4', 'c3', 'd2', 'c1']);
  });

  it('on equal times the changes entry comes first; inside one file the file order is kept', async () => {
    const ws = freshWorkspace();
    put(ws, 'changes', `# Changes\n\n${change(5, 'a', 'c-first')}${change(5, 'b', 'c-second')}`);
    put(ws, 'decisions', `# Decisions\n\n${decision(5, 'd', 'd-first')}`);
    expect((await entriesBetween(ws, ...ALL(), 10)).map((r) => r.summary)).toEqual(['c-first', 'c-second', 'd-first']);
  });

  it('missing files give no entries', async () => {
    const ws = freshWorkspace();
    expect(await entriesBetween(ws, ...ALL(), 10)).toEqual([]);
    put(ws, 'decisions', `# Decisions\n\n${decision(1, 'only', 'one')}`);
    expect((await entriesBetween(ws, ...ALL(), 10)).map((r) => r.file)).toEqual(['decisions']);
  });

  it.each([
    ['LF', (text: string) => text],
    ['CRLF', (text: string) => text.replaceAll('\n', '\r\n')],
    ['lone CR', (text: string) => text.replaceAll('\n', '\r')],
    ['BOM and CRLF', (text: string) => BOM + text.replaceAll('\n', '\r\n')],
  ])('reads the same entries from a file with %s line ends', async (_name, convert) => {
    const ws = freshWorkspace();
    put(ws, 'changes', convert(`# Changes\n\n${change(1, 'a', 'one')}${change(2, 'b', 'two')}`));
    put(ws, 'decisions', convert(`# Decisions\n\n${decision(3, 't', 'three')}`));
    expect((await entriesBetween(ws, ...ALL(), 10)).map((r) => [r.file, r.title, r.summary])).toEqual([
      ['decisions', 't', 'three'],
      ['changes', 'b', 'two'],
      ['changes', 'a', 'one'],
    ]);
  });

  it('skips blocks whose header does not match, without losing the neighbours', async () => {
    const ws = freshWorkspace();
    put(
      ws,
      'changes',
      '# Changes\n\n' +
        change(1, 'good-1', 'one') +
        '## not a timestamp | x\n- Summary: bad\n\n' +
        '## 2026-01-01T00:00:00 | no zone\n- Summary: bad\n\n' +
        '## 2026-01-01T00:00:00Z no pipe\n- Summary: bad\n\n' +
        '## 2026-02-30T00:00:00Z | impossible date\n- Summary: bad\n\n' +
        '## 2026-13-01T00:00:00Z | impossible month\n- Summary: bad\n\n' +
        '## 2026-01-01T24:00:00Z | hour 24\n- Summary: bad\n\n' +
        change(2, 'good-2', 'two'),
    );
    expect((await entriesBetween(ws, ...ALL(), 10)).map((r) => r.summary)).toEqual(['two', 'one']);
  });

  it('trims the title and keeps pipes inside it', async () => {
    const ws = freshWorkspace();
    put(ws, 'changes', `# Changes\n\n## ${ts(1)} |   spaced | piped   \n- Summary: x\n\n`);
    expect((await entriesBetween(ws, ...ALL(), 10))[0]?.title).toBe('spaced | piped');
  });

  it('takes the summary from the first line that starts with "- Summary: " (changes) or "- Decision: " (decisions)', async () => {
    const ws = freshWorkspace();
    put(
      ws,
      'changes',
      `# Changes\n\n## ${ts(1)} | a\n- Reason: mentions - Summary: not this\n- Summary: this one\n- Summary: not this either\n\n` +
        `## ${ts(2)} | b\n- Reason: no summary line\n\n` +
        `## ${ts(3)} | c\n- Summary:\n\n`,
    );
    put(
      ws,
      'decisions',
      `# Decisions\n\n## ${ts(4)} | d\n- Decision: the decision\n- Summary: ignored here\n\n## ${ts(5)} | e\n- Summary: wrong key\n\n`,
    );
    const refs = await entriesBetween(ws, ...ALL(), 10);
    expect(refs.map((r) => [r.title, r.summary])).toEqual([
      ['e', ''],
      ['d', 'the decision'],
      ['c', ''],
      ['b', ''],
      ['a', 'this one'],
    ]);
  });

  it('clips a long summary to 300 code points ending in "..."', async () => {
    const ws = freshWorkspace();
    const exactly = 'x'.repeat(300);
    const longer = 'y'.repeat(301);
    const emoji = String.fromCodePoint(0x1f600);
    const astral = emoji.repeat(301);
    put(ws, 'changes', `# Changes\n\n${change(1, 'a', exactly)}${change(2, 'a', longer)}${change(3, 'a', astral)}`);
    const refs = await entriesBetween(ws, ...ALL(), 10);
    expect(refs[2]?.summary).toBe(exactly);
    expect(refs[1]?.summary).toBe(`${'y'.repeat(297)}...`);
    expect(Array.from(refs[0]?.summary ?? '')).toHaveLength(300);
    expect(refs[0]?.summary).toBe(`${emoji.repeat(297)}...`);
  });

  it('reads the entries the Node writer wrote and the ones the legacy tool wrote, together', async () => {
    const ws = freshWorkspace();
    cpSync(path.join(FIXTURE, 'audit'), path.join(ws.dir, 'audit'), { recursive: true });
    await appendChange(
      ws,
      {
        action: 'engine-switch',
        summary: 'engine: node -> legacy',
        reason: null,
        files: ['instance.json'],
        validation: 'schema ok',
        outcome: 'applied',
      },
      Date.UTC(2026, 9, 12, 8, 0, 0),
    );
    await appendDecision(ws, 'configuration', 'keep the port', null, Date.UTC(2026, 9, 12, 9, 0, 0));
    const refs = await entriesBetween(ws, Date.UTC(2026, 9, 11), Date.UTC(2026, 9, 13), 10);
    expect(refs.map((r) => [r.file, r.at, r.title, r.summary])).toEqual([
      ['decisions', '2026-10-12T09:00:00.000Z', 'configuration', 'keep the port'],
      ['changes', '2026-10-12T08:00:00.000Z', 'engine-switch', 'engine: node -> legacy'],
      ['changes', '2026-10-11T16:38:28.000Z', 'init-task', "created task workspace 'legacy-demo'"],
      ['changes', '2026-10-11T16:38:28.000Z', 'configure', 'window_hours: (default 8) -> 12'],
      ['decisions', '2026-10-11T16:38:28.000Z', 'Keep the window short', 'Use a twelve hour window for the fixture.'],
    ]);
  });

  it('refuses arguments that are not numbers or not a whole limit', async () => {
    const ws = freshWorkspace();
    await expect(entriesBetween(ws, Number.NaN, 1, 1)).rejects.toThrow(RangeError);
    await expect(entriesBetween(ws, 0, Number.POSITIVE_INFINITY, 1)).rejects.toThrow(RangeError);
    await expect(entriesBetween(ws, 0, 1, -1)).rejects.toThrow(RangeError);
    await expect(entriesBetween(ws, 0, 1, 1.5)).rejects.toThrow(RangeError);
  });

  describe('a file larger than 4 MiB', () => {
    const MIB4 = 4 * 1024 * 1024;
    const HEADER = '# Changes\n\n';
    const entry = (i: number): string => change(i, 'configure', `${String(i).padStart(6, '0')} ${'p'.repeat(150)}`);
    /** Every entry has the same size, so the byte offset of entry i is `HEADER + i * ENTRY_BYTES`. */
    const ENTRY_BYTES = Buffer.byteLength(entry(0));
    const at = (i: number): number => T0 + i * 1000;

    function bigFile(count: number): string {
      const parts: string[] = [HEADER];
      for (let i = 0; i < count; i += 1) parts.push(entry(i));
      return parts.join('');
    }

    it('reads only the last 4 MiB, drops the first partial block and logs audit_truncated once', async () => {
      const ws = freshWorkspace();
      const count = Math.ceil((MIB4 + 300_000) / ENTRY_BYTES);
      const text = bigFile(count);
      const size = Buffer.byteLength(text);
      expect(size).toBeGreaterThan(MIB4);
      put(ws, 'changes', text);
      const cut = size - MIB4;
      // The first entry that starts after the cut is the first one that is read.
      const firstRead = Math.floor((cut - Buffer.byteLength(HEADER)) / ENTRY_BYTES) + 1;
      const warn = vi.fn();
      const log = { warn };

      const first = await entriesBetween(ws, at(firstRead), at(firstRead), 5, { log });
      expect(first.map((r) => r.summary.slice(0, 6))).toEqual([String(firstRead).padStart(6, '0')]);
      const before = await entriesBetween(ws, at(firstRead - 1), at(firstRead - 1), 5, { log });
      expect(before).toEqual([]);
      const newest = await entriesBetween(ws, 0, Date.UTC(2100, 0, 1), 2, { log });
      expect(newest.map((r) => r.summary.slice(0, 6))).toEqual([
        String(count - 1).padStart(6, '0'),
        String(count - 2).padStart(6, '0'),
      ]);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe('audit_truncated');
    });

    it('a file of exactly 4 MiB is read whole', async () => {
      const ws = freshWorkspace();
      const text = bigFile(Math.floor((MIB4 - 64) / ENTRY_BYTES));
      const pad = MIB4 - Buffer.byteLength(text);
      expect(pad).toBeGreaterThanOrEqual(0);
      // The padding goes into the file header line, so every block stays whole and the size is exactly the limit.
      const padded = text.replace(HEADER, `# Changes${' '.repeat(pad)}\n\n`);
      expect(Buffer.byteLength(padded)).toBe(MIB4);
      put(ws, 'changes', padded);
      const warn = vi.fn();
      const refs = await entriesBetween(ws, at(0), at(0), 5, { log: { warn } });
      expect(refs).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
