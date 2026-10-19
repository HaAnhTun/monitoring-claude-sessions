// `summarizeHandlerLog` (02 2.11, ADR 0070): the hook handler's own log, read as a count and a last time per code. The tail is
// bounded, a torn line is skipped, and no text of a line other than its code and time ever leaves the function.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import {
  HANDLER_LOG_FILE,
  HANDLER_LOG_MAX_CODES,
  HANDLER_LOG_TAIL_BYTES,
  handlerLogPath,
  rotatedLogPath,
  summarizeHandlerLog,
} from './handler-log.ts';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);

/** One line as the handler writes it (cli/src/hook/handler-log.ts). */
function line(code: string, at: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ at, code, event: 'Stop', instanceId: null, pid: 4242, detail: '', ...extra }) + LF;
}

function logIn(root: string): { file: string; rotated: string } {
  const dir = path.join(root, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HANDLER_LOG_FILE);
  return { file, rotated: rotatedLogPath(file) };
}

describe('the paths of the log', () => {
  it('puts the log in logs/ of MCS_HOME and the rotated file next to it', () => {
    expect(handlerLogPath('/state/mcs')).toBe(path.join('/state/mcs', 'logs', 'hook-handler.jsonl'));
    expect(rotatedLogPath(path.join('/state/mcs', 'logs', 'hook-handler.jsonl'))).toBe(
      path.join('/state/mcs', 'logs', 'hook-handler.1.jsonl'),
    );
    expect(rotatedLogPath('/x/other.log')).toBe('/x/other.log.1');
  });
});

describe('summarizeHandlerLog', () => {
  it('is empty for a missing log, an empty log and a folder where the log should be', async () => {
    const root = makeTemp('hlog-empty').path;
    const { file } = logIn(root);
    expect(await summarizeHandlerLog(file)).toEqual([]);
    writeFileSync(file, '');
    expect(await summarizeHandlerLog(file)).toEqual([]);
    const dirLog = path.join(root, 'logs', 'dir', HANDLER_LOG_FILE);
    mkdirSync(dirLog, { recursive: true });
    expect(await summarizeHandlerLog(dirLog)).toEqual([]);
  });

  it('counts the lines of each code and keeps the newest time, newest code first', async () => {
    const { file } = logIn(makeTemp('hlog-count').path);
    writeFileSync(
      file,
      line('SPOOL_FULL', 1000) +
        line('ROUTE_INVALID', 2000) +
        line('SPOOL_FULL', 5000) +
        line('SPOOL_FULL', 3000) +
        line('UNCAUGHT', 4000),
    );
    expect(await summarizeHandlerLog(file)).toEqual([
      { code: 'SPOOL_FULL', count: 3, lastAt: 5000 },
      { code: 'UNCAUGHT', count: 1, lastAt: 4000 },
      { code: 'ROUTE_INVALID', count: 1, lastAt: 2000 },
    ]);
  });

  it('breaks a tie of times by the code', async () => {
    const { file } = logIn(makeTemp('hlog-tie').path);
    writeFileSync(file, line('UNCAUGHT', 7) + line('ROUTE_INVALID', 7));
    const codes = (await summarizeHandlerLog(file)).map((entry) => entry.code);
    expect(codes).toEqual(['ROUTE_INVALID', 'UNCAUGHT']);
  });

  it('reads the rotated file as well (older lines), and a line is counted once', async () => {
    const { file, rotated } = logIn(makeTemp('hlog-rotated').path);
    writeFileSync(rotated, line('SPOOL_FULL', 100) + line('ROUTE_INVALID', 200));
    writeFileSync(file, line('SPOOL_FULL', 900));
    expect(await summarizeHandlerLog(file)).toEqual([
      { code: 'SPOOL_FULL', count: 2, lastAt: 900 },
      { code: 'ROUTE_INVALID', count: 1, lastAt: 200 },
    ]);
  });

  it('reads the rotated file alone when the current one does not exist yet', async () => {
    const { file, rotated } = logIn(makeTemp('hlog-rotated-only').path);
    writeFileSync(rotated, line('STDIN_PARSE_ERROR', 300));
    expect(await summarizeHandlerLog(file)).toEqual([{ code: 'STDIN_PARSE_ERROR', count: 1, lastAt: 300 }]);
  });

  it('skips a torn last line, a damaged line and a line of another shape', async () => {
    const { file } = logIn(makeTemp('hlog-torn').path);
    const torn = line('SPOOL_FULL', 999).slice(0, 25);
    writeFileSync(
      file,
      line('SPOOL_FULL', 100) +
        'not json at all' +
        LF +
        '[1,2,3]' +
        LF +
        '"text"' +
        LF +
        JSON.stringify({ code: 'NO_TIME' }) +
        LF +
        JSON.stringify({ at: -5, code: 'NEGATIVE' }) +
        LF +
        JSON.stringify({ at: 'soon', code: 'TEXT_TIME' }) +
        LF +
        LF +
        line('SPOOL_FULL', 200) +
        torn,
    );
    expect(await summarizeHandlerLog(file)).toEqual([{ code: 'SPOOL_FULL', count: 2, lastAt: 200 }]);
  });

  it('counts a code it does not know under its own name', async () => {
    const { file } = logIn(makeTemp('hlog-unknown').path);
    writeFileSync(file, line('FUTURE_CODE_9', 10) + line('FUTURE_CODE_9', 20));
    expect(await summarizeHandlerLog(file)).toEqual([{ code: 'FUTURE_CODE_9', count: 2, lastAt: 20 }]);
  });

  it('counts a code of a hostile shape under UNKNOWN and never repeats it', async () => {
    const { file } = logIn(makeTemp('hlog-hostile-code').path);
    const hostile = [
      '<img src=x onerror=alert(1)>',
      'x'.repeat(5000),
      'lower_case',
      'WITH SPACE',
      'ESC' + String.fromCharCode(27) + '[31m',
    ];
    writeFileSync(
      file,
      hostile.map((code, i) => line(code, 100 + i)).join('') +
        JSON.stringify({ at: 500, code: 12 }) +
        LF +
        JSON.stringify({ at: 600 }) +
        LF,
    );
    const result = await summarizeHandlerLog(file);
    expect(result).toEqual([{ code: 'UNKNOWN', count: 7, lastAt: 600 }]);
    expect(JSON.stringify(result)).not.toContain('onerror');
  });

  it('bounds the number of distinct codes; the overflow is counted under UNKNOWN', async () => {
    const { file } = logIn(makeTemp('hlog-many').path);
    const lines: string[] = [];
    for (let i = 0; i < HANDLER_LOG_MAX_CODES + 10; i += 1) lines.push(line(`CODE_${String(i)}`, 1000 + i));
    writeFileSync(file, lines.join(''));
    const result = await summarizeHandlerLog(file);
    expect(result.length).toBeLessThanOrEqual(HANDLER_LOG_MAX_CODES + 1);
    expect(result.reduce((sum, entry) => sum + entry.count, 0)).toBe(HANDLER_LOG_MAX_CODES + 10);
    expect(result.find((entry) => entry.code === 'UNKNOWN')?.count).toBe(10);
  });

  it('never copies the detail, the event, the instance id or the pid of a line', async () => {
    const { file } = logIn(makeTemp('hlog-detail').path);
    writeFileSync(
      file,
      line('UNCAUGHT', 50, {
        detail: 'FIXTURE-SECRET-TOKEN C:/Users/alice/private.txt',
        event: 'FIXTURE-SECRET-EVENT',
        instanceId: '11111111-1111-4111-8111-111111111111',
      }) + line('SPOOL_FULL', 60, { detail: 'a'.repeat(1000), extra: { nested: 'FIXTURE-SECRET-NESTED' } }),
    );
    const result = await summarizeHandlerLog(file);
    const text = JSON.stringify(result);
    for (const secret of ['FIXTURE-SECRET', 'private.txt', '1111-4111', 'nested', '4242']) {
      expect(text).not.toContain(secret);
    }
    expect(result.map((entry) => Object.keys(entry).sort())).toEqual([
      ['code', 'count', 'lastAt'],
      ['code', 'count', 'lastAt'],
    ]);
  });

  it('reads at most 64 KiB of the log: older lines are not counted, and the cut line is not counted', async () => {
    const { file, rotated } = logIn(makeTemp('hlog-cap').path);
    const oldLine = line('OLD_CODE', 1);
    const newLine = line('NEW_CODE', 2);
    expect(oldLine.length).toBe(newLine.length);
    const perLine = newLine.length;
    const oldCount = Math.ceil((HANDLER_LOG_TAIL_BYTES * 2) / perLine);
    const newCount = Math.ceil((HANDLER_LOG_TAIL_BYTES * 2) / perLine);
    writeFileSync(file, oldLine.repeat(oldCount) + newLine.repeat(newCount));
    writeFileSync(rotated, line('ROTATED_ONLY', 3).repeat(50));
    const result = await summarizeHandlerLog(file);
    expect(result.map((entry) => entry.code)).toEqual(['NEW_CODE']);
    const counted = result[0]?.count ?? 0;
    expect(counted).toBeLessThanOrEqual(Math.floor(HANDLER_LOG_TAIL_BYTES / perLine));
    expect(counted).toBeGreaterThanOrEqual(Math.floor(HANDLER_LOG_TAIL_BYTES / perLine) - 1);
  });

  it('shares one 64 KiB budget between the log and its rotated file', async () => {
    const { file, rotated } = logIn(makeTemp('hlog-budget').path);
    const perLine = line('CURRENT_CODE', 2).length;
    const currentCount = 100;
    const rotatedCount = Math.ceil((HANDLER_LOG_TAIL_BYTES * 2) / perLine);
    writeFileSync(file, line('CURRENT_CODE', 2).repeat(currentCount));
    writeFileSync(rotated, line('ROTATED_CODE', 1).repeat(rotatedCount));
    const result = await summarizeHandlerLog(file);
    const current = result.find((entry) => entry.code === 'CURRENT_CODE');
    const older = result.find((entry) => entry.code === 'ROTATED_CODE');
    expect(current?.count).toBe(currentCount);
    const room = HANDLER_LOG_TAIL_BYTES - currentCount * perLine;
    expect(older?.count ?? 0).toBeLessThanOrEqual(Math.floor(room / perLine));
    expect(older?.count ?? 0).toBeGreaterThanOrEqual(Math.floor(room / perLine) - 1);
  });

  it('counts the first line when the whole file fits in the window', async () => {
    const { file } = logIn(makeTemp('hlog-whole').path);
    // the file is smaller than the window: nothing is cut, so the first line is a whole line
    const text = line('EXACT_CODE', 9);
    const count = Math.floor(HANDLER_LOG_TAIL_BYTES / text.length);
    writeFileSync(file, text.repeat(count));
    expect((await summarizeHandlerLog(file))[0]?.count).toBe(count);
  });

  // a file link needs a privilege on Windows; the reading itself is the same as for a plain file
  it.skipIf(process.platform === 'win32')(
    'follows a link to the log (the log of a state folder kept elsewhere)',
    async () => {
      const root = makeTemp('hlog-link').path;
      const { file } = logIn(root);
      const real = path.join(root, 'elsewhere.jsonl');
      writeFileSync(real, line('SPOOL_FULL', 77));
      symlinkSync(real, file, 'file');
      expect(await summarizeHandlerLog(file)).toEqual([{ code: 'SPOOL_FULL', count: 1, lastAt: 77 }]);
    },
  );
});
