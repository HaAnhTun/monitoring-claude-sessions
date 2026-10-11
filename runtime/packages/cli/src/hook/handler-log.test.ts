import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { HANDLER_LOG_MAX_BYTES, cleanDetail, handlerLogLine, logHandler } from './handler-log.ts';

const makeTemp = useTempDirs();
const LF = String.fromCharCode(10);

describe('cleanDetail', () => {
  it('keeps printable ASCII, replaces the rest and cuts at 120 characters', () => {
    expect(cleanDetail('abc 123')).toBe('abc 123');
    expect(cleanDetail('a' + LF + 'b')).toBe('a?b');
    expect(cleanDetail('caf' + String.fromCharCode(233))).toBe('caf?');
    expect(cleanDetail('x'.repeat(500))).toHaveLength(120);
  });
});

describe('handlerLogLine', () => {
  it('has the keys of 02 2.11 in order and ends with one newline', () => {
    const line = handlerLogLine({ code: 'SPOOL_FULL', event: 'Stop', instanceId: null, detail: 'hard cap' }, 5, 77);
    expect(line.endsWith(LF)).toBe(true);
    expect(Object.keys(JSON.parse(line) as object)).toEqual(['at', 'code', 'event', 'instanceId', 'pid', 'detail']);
    expect(JSON.parse(line)).toEqual({
      at: 5,
      code: 'SPOOL_FULL',
      event: 'Stop',
      instanceId: null,
      pid: 77,
      detail: 'hard cap',
    });
  });
});

describe('logHandler', () => {
  it('appends lines below <home>/logs', () => {
    const home = makeTemp('hlog').path;
    logHandler(home, { code: 'ROUTE_INVALID', event: 'Stop', instanceId: null, detail: 'a.json' }, 1, 2);
    logHandler(home, { code: 'UNCAUGHT', event: '', instanceId: null }, 3, 2);
    const lines = readFileSync(join(home, 'logs', 'hook-handler.jsonl'), 'utf8')
      .split(LF)
      .filter(Boolean);
    expect(lines.map((line) => (JSON.parse(line) as { code: string }).code)).toEqual(['ROUTE_INVALID', 'UNCAUGHT']);
  });

  it('rotates a file of 1 MiB to hook-handler.1.jsonl, replacing the older one', () => {
    const home = makeTemp('hlog').path;
    mkdirSync(join(home, 'logs'));
    writeFileSync(join(home, 'logs', 'hook-handler.jsonl'), 'x'.repeat(HANDLER_LOG_MAX_BYTES));
    writeFileSync(join(home, 'logs', 'hook-handler.1.jsonl'), 'old');
    logHandler(home, { code: 'SPOOL_FULL', event: 'Stop', instanceId: null }, 1, 2);
    expect(readFileSync(join(home, 'logs', 'hook-handler.1.jsonl'), 'utf8')).toHaveLength(HANDLER_LOG_MAX_BYTES);
    expect(readFileSync(join(home, 'logs', 'hook-handler.jsonl'), 'utf8')).toContain('SPOOL_FULL');
  });

  it('never throws: no home, or a home that is a file', () => {
    expect(() => {
      logHandler(null, { code: 'UNCAUGHT', event: '', instanceId: null });
    }).not.toThrow();
    const home = join(makeTemp('hlog').path, 'file');
    writeFileSync(home, 'x');
    expect(() => {
      logHandler(home, { code: 'UNCAUGHT', event: '', instanceId: null });
    }).not.toThrow();
    expect(existsSync(join(home, 'logs'))).toBe(false);
  });
});
