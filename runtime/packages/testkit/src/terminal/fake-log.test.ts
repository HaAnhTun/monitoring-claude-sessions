import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { useTempDirs } from '../temp.ts';
import { fakeLogOf, readFakeLog } from './fake-log.ts';

const makeTemp = useTempDirs();

function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

describe('readFakeLog', () => {
  it('is an empty log while the file does not exist: no fake claude has started', () => {
    const log = readFakeLog(path.join(makeTemp('fake-log').path, 'fake-claude.log'));
    expect(log.entries).toEqual([]);
    expect(log.count('start')).toBe(0);
    expect(log.stdin()).toEqual(Buffer.alloc(0));
    expect(log.runs()).toEqual([]);
  });

  it('answers the counts, the stdin bytes, the commands and the exit codes of a written log', () => {
    const file = path.join(makeTemp('fake-log').path, 'fake-claude.log');
    writeFileSync(
      file,
      [
        line({ n: 1, ev: 'start', argv: [], env: ['PATH'] }),
        line({ n: 2, ev: 'stdin', hex: Buffer.from('/si').toString('hex') }),
        line({ n: 3, ev: 'stdin', hex: Buffer.from('ze\r').toString('hex') }),
        line({ n: 4, ev: 'cmd', name: '/size', args: 0 }),
        line({ n: 5, ev: 'cmd', name: 'text', args: 2 }),
        line({ n: 6, ev: 'exit', code: 0 }),
        line({ n: 1, ev: 'start', argv: ['--resume'], env: [] }),
        line({ n: 2, ev: 'exit', code: 3 }),
      ].join(''),
    );
    const log = readFakeLog(file);
    expect(log.entries).toHaveLength(8);
    expect(log.count('start')).toBe(2);
    expect(log.of('cmd').map((entry) => entry.n)).toEqual([4, 5]);
    expect(log.stdin().toString('utf8')).toBe('/size\r');
    expect(log.commands()).toEqual(['/size', 'text']);
    expect(log.exitCodes()).toEqual([0, 3]);
    expect(log.runs().map((run) => run.length)).toEqual([6, 2]);
  });

  it('leaves a line that is still being written for the next read', () => {
    const file = path.join(makeTemp('fake-log').path, 'fake-claude.log');
    writeFileSync(file, `${line({ n: 1, ev: 'start', argv: [], env: [] })}{"n":2,"ev":"std`);
    expect(readFakeLog(file).entries).toHaveLength(1);
    appendFileSync(file, 'in","hex":"41"}\n');
    expect(readFakeLog(file).stdin().toString('utf8')).toBe('A');
  });

  it('throws for a complete line that is not a log entry', () => {
    const file = path.join(makeTemp('fake-log').path, 'fake-claude.log');
    writeFileSync(file, '{"hello":"world"}\n');
    expect(() => readFakeLog(file)).toThrow(/not a fake claude log entry/);
  });
});

describe('fakeLogOf', () => {
  it('ignores an exit entry without a numeric code and a stdin entry without hex', () => {
    const log = fakeLogOf([
      { n: 1, ev: 'stdin' },
      { n: 2, ev: 'exit', code: null },
      { n: 3, ev: 'exit', code: 7 },
    ]);
    expect(log.stdin()).toEqual(Buffer.alloc(0));
    expect(log.exitCodes()).toEqual([7]);
    // entries before the first start still form a group
    expect(log.runs()).toHaveLength(1);
  });
});
