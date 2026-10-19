// The allow-listed JSON logger and its rotation (05 5.3 S-LOG-1..6, 5.7, SEC-22, SEC-31).
// Real files cover the rotation chain and the held-file cases; an in-memory file system covers the retry schedule, the
// budget and the 60 s pause without waiting for them.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  FILE_HOLDER_SKIP_REASON,
  FIXTURE_EPOCH_MS,
  FakeClock,
  holdFileOpen,
  useTempDirs,
  waitFor,
  type FileHolder,
} from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import {
  LOG_FIELD_NAMES,
  LOG_KEEP,
  LOG_MAX_QUEUED_LINES,
  LOG_ROTATE_BYTES,
  LOG_ROTATE_RETRY_BUDGET_MS,
  createLogger,
  createLoggerWith,
  type LogFile,
  type LogLevel,
  type Logger,
  type LoggerDeps,
  type LoggerOptions,
} from './logger.ts';

const makeTemp = useTempDirs();

function logDir(): string {
  const dir = path.join(makeTemp('logger').path, 'logs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function options(file: string | null, clock: FakeClock, extra: Partial<LoggerOptions> = {}): LoggerOptions {
  return { file, level: 'debug', rotate: true, clock, ...extra };
}

function parseLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): Record<string, unknown> => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`not an object: ${line}`);
      return Object.fromEntries(Object.entries(value));
    });
}

function readLog(file: string): Record<string, unknown>[] {
  return parseLines(readFileSync(file, 'utf8'));
}

/** Runs `log` against a logger on a real file, closes it (which flushes) and returns the lines written. */
async function capture(
  extra: Partial<LoggerOptions>,
  log: (logger: Logger) => void,
): Promise<{ lines: Record<string, unknown>[]; logger: Logger }> {
  const file = path.join(logDir(), 'runtime.log');
  const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS), extra));
  log(logger);
  await logger.close();
  return { lines: existsSync(file) ? readLog(file) : [], logger };
}

describe('constants (S-LOG-6)', () => {
  it('keeps 5 files of 10 MiB and retries a rotation for 3 s', () => {
    expect(LOG_ROTATE_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_KEEP).toBe(5);
    expect(LOG_ROTATE_RETRY_BUDGET_MS).toBe(3000);
  });

  it('allow-lists exactly the fields of S-LOG-1', () => {
    expect([...LOG_FIELD_NAMES]).toEqual([
      'event',
      'instanceId',
      'sessionId',
      'agentId',
      'code',
      'count',
      'durationMs',
      'bytes',
      'offset',
      'port',
      'pid',
      'status',
      'method',
      'route',
      'version',
      'schemaVersion',
      'phase',
      'requestId',
      'kind',
    ]);
  });
});

describe('line format and the field allow-list (S-LOG-1, SEC-22)', () => {
  it('writes one JSON object per line: ts from the clock, level, event, then the allowed fields in list order', async () => {
    const { lines, logger } = await capture({}, (log) => {
      log.info('ingest.drain', {
        phase: 'drain',
        count: 3,
        code: 'OK',
        durationMs: 12.5,
        instanceId: '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11',
      });
    });
    expect(lines).toEqual([
      {
        ts: '2026-01-01T00:00:00.000Z',
        level: 'info',
        event: 'ingest.drain',
        instanceId: '0b6f0f4e-6c1e-4a46-9d0a-0a5b3f7c9e11',
        code: 'OK',
        count: 3,
        durationMs: 12.5,
        phase: 'drain',
      },
    ]);
    expect(Object.keys(lines[0] ?? {})).toEqual([
      'ts',
      'level',
      'event',
      'instanceId',
      'code',
      'count',
      'durationMs',
      'phase',
    ]);
    expect(logger.stats).toEqual({ droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 });
  });

  it('accepts every allow-listed field with a number, boolean or safe string', async () => {
    const fields: Record<string, string | number | boolean> = {
      instanceId: 'i-1',
      sessionId: 's-1',
      agentId: 'main',
      code: 'E_X',
      count: 1,
      durationMs: 2,
      bytes: 3,
      offset: 4,
      port: 18000,
      pid: 5,
      status: 200,
      method: 'GET',
      route: '/api/v3/sessions/:sessionId',
      version: '3.0.0',
      schemaVersion: 1,
      phase: true,
      requestId: 'r-0123456789ab',
      kind: 'powershell.processes',
    };
    const { lines, logger } = await capture({}, (log) => {
      log.warn('all', fields);
    });
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'all', ...fields });
    expect(logger.stats.droppedFields).toBe(0);
  });

  it('keeps requestId and kind when they are safe strings and drops them otherwise (CR-WP-17-9, CR-WP-16-3)', async () => {
    const { lines, logger } = await capture({}, (log) => {
      log.debug('child_run', { kind: 'git', requestId: 'r-0123456789ab', durationMs: 3, code: 0 });
      log.debug('child_run', { kind: 'has space', requestId: 'line' + String.fromCharCode(10) + 'break' });
      log.debug('child_run', { kind: 42, requestId: { id: 'r-1' } });
      log.debug('child_run', { kind: 'x'.repeat(129) });
    });
    expect(lines[0]).toMatchObject({
      event: 'child_run',
      requestId: 'r-0123456789ab',
      kind: 'git',
      durationMs: 3,
      code: 0,
    });
    expect(lines[1]).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'debug', event: 'child_run' });
    expect(lines[2]).toMatchObject({ kind: 42 });
    expect(lines[2]).not.toHaveProperty('requestId');
    expect(lines[3]).not.toHaveProperty('kind');
    expect(logger.stats.droppedFields).toBe(4);
  });

  it('drops fields that are not on the list and counts each one', async () => {
    const { lines, logger } = await capture({}, (log) => {
      log.info('x', {
        code: 'OK',
        token: 'abc',
        query: 'secret search text',
        prompt: 'hello',
        env: 'PATH',
        path: '/a/b',
        err: new Error('nope'),
      });
    });
    expect(lines[0]).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'x', code: 'OK' });
    expect(logger.stats.droppedFields).toBe(6);
    expect(JSON.stringify(lines)).not.toContain('secret search text');
  });

  it('reads own properties only, never ones inherited from a prototype', async () => {
    const fields = Object.create({ code: 'inherited', count: 7 }) as Record<string, unknown>;
    fields['status'] = 200;
    const { lines } = await capture({}, (log) => {
      log.info('own', fields);
    });
    expect(lines[0]).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'own', status: 200 });
  });

  it('ignores a field named event: the first argument is the event', async () => {
    const { lines, logger } = await capture({}, (log) => {
      log.info('real', { event: 'fake' });
    });
    expect(lines[0]?.['event']).toBe('real');
    expect(logger.stats.droppedFields).toBe(1);
  });

  it('keeps strings of the shape ^[\\w.:/@-]{0,128}$ and drops everything else', async () => {
    const accepted = [
      '',
      'a',
      'A_b-c.d:e/f@g',
      'x'.repeat(128),
      '/api/v3/events/:eventId',
      '0b6f0f4e-6c1e-4a46',
      '..',
      'C:/x',
    ];
    const rejected = [
      ' ',
      'a b',
      'a\nb',
      'a\rb',
      'a\tb',
      'a\\b',
      'x'.repeat(129),
      '\u00e9',
      '\u0111',
      '\u202e',
      '"',
      "'",
      '?',
      '=',
      '&',
      '%41',
      '#',
      'a;b',
      '<b>',
      'a,b',
      'a\0b',
      'abc\n',
      '/api/v3/events?q=secret',
      'GET /api',
      'Unexpected token } in JSON at position 1',
    ];
    const { lines, logger } = await capture({}, (log) => {
      for (const value of accepted) log.info('ok', { code: value });
      for (const value of rejected) log.info('no', { code: value });
    });
    expect(lines.filter((l) => l['event'] === 'ok').map((l) => l['code'])).toEqual(accepted);
    expect(lines.filter((l) => l['event'] === 'no').every((l) => !('code' in l))).toBe(true);
    expect(logger.stats.droppedFields).toBe(rejected.length);
  });

  it('keeps finite numbers and booleans, drops other value types, skips undefined silently', async () => {
    const noValue = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
      {},
      [],
      ['a'],
      () => 1,
      Symbol('s'),
      10n,
      new Date(0),
      new Error('x'),
    ];
    const { lines, logger } = await capture({}, (log) => {
      log.info('n', { count: 0 });
      log.info('n', { count: -1.5 });
      log.info('b', { phase: false });
      log.info('u', { code: undefined });
      for (const value of noValue) log.info('bad', { count: value });
    });
    expect(lines.filter((l) => l['event'] === 'n').map((l) => l['count'])).toEqual([0, -1.5]);
    expect(lines.find((l) => l['event'] === 'b')?.['phase']).toBe(false);
    expect(lines.find((l) => l['event'] === 'u')).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'u',
    });
    expect(lines.filter((l) => l['event'] === 'bad').every((l) => !('count' in l))).toBe(true);
    expect(logger.stats.droppedFields).toBe(noValue.length);
  });

  it('replaces an unsafe event name with invalid_event and counts it', async () => {
    const { lines, logger } = await capture({}, (log) => {
      log.info('has space');
      log.info('');
      log.info('a'.repeat(129));
    });
    expect(lines.map((l) => l['event'])).toEqual(['invalid_event', 'invalid_event', 'invalid_event']);
    expect(logger.stats.droppedFields).toBe(3);
  });

  it('survives a field whose getter throws: the field is dropped and the caller sees nothing', async () => {
    const fields = { code: 'OK' };
    Object.defineProperty(fields, 'count', {
      enumerable: true,
      get: () => {
        throw new Error('getter exploded with secret text');
      },
    });
    const { lines, logger } = await capture({}, (log) => {
      expect(() => {
        log.info('g', fields);
      }).not.toThrow();
    });
    expect(lines).toEqual([{ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'g', code: 'OK' }]);
    expect(logger.stats.droppedFields).toBe(1);
    expect(JSON.stringify(lines)).not.toContain('secret text');
  });
});

describe('what is never logged (S-LOG-2)', () => {
  it('never prints the message of a SyntaxError, only its name', async () => {
    let failure: unknown;
    try {
      JSON.parse('{"prompt": hunter2-secret-text}');
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof SyntaxError)) throw new Error('JSON.parse should have thrown a SyntaxError');
    expect(failure.message.length).toBeGreaterThan(0);
    const { lines, logger } = await capture({}, (log) => {
      log.error('parse.failed', { code: failure.message, err: failure, message: failure.message });
      log.error('parse.failed', { code: failure.name });
    });
    expect(lines[0]).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'error', event: 'parse.failed' });
    expect(lines[1]).toMatchObject({ code: 'SyntaxError' });
    expect(logger.stats.droppedFields).toBe(3);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
    expect(JSON.stringify(lines)).not.toContain(failure.message);
  });

  it('never logs query text, tokens or request bodies, whatever the field is called', async () => {
    const { lines } = await capture({}, (log) => {
      log.info('request', {
        method: 'GET',
        route: '/api/v3/events',
        q: 'needle-in-search',
        query: 'needle-in-search',
        search: 'needle-in-search',
        token: 'tok-1234',
        authorization: 'Bearer tok-1234',
        body: '{"instanceId":"x"}',
        status: 200,
      });
    });
    expect(lines[0]).toMatchObject({ method: 'GET', route: '/api/v3/events', status: 200 });
    expect(JSON.stringify(lines)).not.toMatch(/needle|tok-1234|instanceId/);
  });

  it('drops a URL with a query string used as the route', async () => {
    const { lines, logger } = await capture({}, (log) => {
      log.info('request', { route: '/api/v3/events?q=needle', method: 'GET' });
    });
    expect(lines[0]).toEqual({ ts: '2026-01-01T00:00:00.000Z', level: 'info', event: 'request', method: 'GET' });
    expect(logger.stats.droppedFields).toBe(1);
  });
});

describe('levels', () => {
  const emit = (logger: Logger) => {
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');
  };

  it.each<[LogLevel, string[]]>([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ])('level %s writes %j', async (level, expected) => {
    const { lines } = await capture({ level }, emit);
    expect(lines.map((l) => l['event'])).toEqual(expected);
    expect(lines.map((l) => l['level'])).toEqual(expected);
  });
});

describe('files, ordering and shutdown', () => {
  it('creates the folder, appends to an existing file and keeps call order', async () => {
    const file = path.join(makeTemp('logger').path, 'deep', 'er', 'runtime.log');
    const first = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS)));
    for (let i = 0; i < 50; i += 1) first.info('one', { count: i });
    await first.close();
    const second = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS)));
    for (let i = 50; i < 100; i += 1) second.info('two', { count: i });
    await second.close();
    const lines = readLog(file);
    expect(lines.map((l) => l['count'])).toEqual(Array.from({ length: 100 }, (_v, i) => i));
    expect(lines.slice(0, 50).every((l) => l['event'] === 'one')).toBe(true);
  });

  it('returns at once: the line is written after the call, and close() flushes', async () => {
    const file = path.join(logDir(), 'runtime.log');
    const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS)));
    logger.info('late');
    await logger.close();
    expect(readLog(file)).toHaveLength(1);
  });

  it('ignores calls after close() and close() can be repeated', async () => {
    const file = path.join(logDir(), 'runtime.log');
    const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS)));
    logger.info('before');
    await logger.close();
    logger.info('after');
    await logger.close();
    expect(readLog(file).map((l) => l['event'])).toEqual(['before']);
  });

  it('never throws into the caller when the file cannot be opened, and counts the lost line', async () => {
    const dir = logDir();
    const blocker = path.join(dir, 'file-not-folder');
    writeFileSync(blocker, 'x');
    const logger = createLogger(options(path.join(blocker, 'runtime.log'), new FakeClock(FIXTURE_EPOCH_MS)));
    expect(() => {
      logger.error('lost');
    }).not.toThrow();
    await logger.close();
    expect(logger.stats.writeFailures).toBe(1);
  });

  it('writes to stderr when there is no file (CLI sink), synchronously, with no file handle', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createLogger(options(null, new FakeClock(FIXTURE_EPOCH_MS), { level: 'info' }));
    logger.debug('hidden');
    logger.info('shown', { count: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"shown","count":1}\n');
    await logger.close();
  });
});

describe('rotation on real files (S-LOG-6, SEC-31)', () => {
  /** A fixed-width line so that the number of lines per file is exact. */
  const LINE_BYTES = Buffer.byteLength(
    '{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"tick","count":1000}\n',
  );
  const PER_FILE = Math.floor(1024 / LINE_BYTES);

  function tick(logger: Logger, from: number, to: number): void {
    for (let n = from; n < to; n += 1) logger.info('tick', { count: 1000 + n });
  }

  const names = (dir: string) => readdirSync(dir).sort();

  it('after 7 rotations exactly runtime.log and .1 to .5 exist, newest lines in .1, order preserved', async () => {
    const dir = logDir();
    const file = path.join(dir, 'runtime.log');
    const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS), { rotateBytes: 1024 }));
    const total = 7 * PER_FILE + 1;
    tick(logger, 0, total);
    await logger.close();
    expect(logger.stats.rotations).toBe(7);
    expect(logger.stats.rotateFailures).toBe(0);
    expect(names(dir)).toEqual([
      'runtime.log',
      'runtime.log.1',
      'runtime.log.2',
      'runtime.log.3',
      'runtime.log.4',
      'runtime.log.5',
    ]);
    const counts = (name: string) => readLog(path.join(dir, name)).map((l) => Number(l['count']) - 1000);
    expect(counts('runtime.log')).toEqual([7 * PER_FILE]);
    expect(counts('runtime.log.1')).toEqual(Array.from({ length: PER_FILE }, (_v, i) => 6 * PER_FILE + i));
    expect(counts('runtime.log.5')).toEqual(Array.from({ length: PER_FILE }, (_v, i) => 2 * PER_FILE + i));
    const oldestToNewest = [
      'runtime.log.5',
      'runtime.log.4',
      'runtime.log.3',
      'runtime.log.2',
      'runtime.log.1',
      'runtime.log',
    ].flatMap(counts);
    expect(oldestToNewest).toEqual(Array.from({ length: total - 2 * PER_FILE }, (_v, i) => 2 * PER_FILE + i));
    for (const name of names(dir)) expect(readFileSync(path.join(dir, name)).length).toBeLessThanOrEqual(1024);
  });

  it('never leaves more than LOG_KEEP rotated files however long it runs', async () => {
    const dir = logDir();
    const logger = createLogger(
      options(path.join(dir, 'runtime.log'), new FakeClock(FIXTURE_EPOCH_MS), { rotateBytes: 1024 }),
    );
    tick(logger, 0, 30 * PER_FILE);
    await logger.close();
    expect(names(dir)).toHaveLength(LOG_KEEP + 1);
    expect(existsSync(path.join(dir, 'runtime.log.6'))).toBe(false);
  });

  it('rotates a file that is already too large before the first line, and an empty file is never rotated', async () => {
    const dir = logDir();
    const file = path.join(dir, 'runtime.log');
    writeFileSync(file, `${'x'.repeat(1023)}\n`);
    const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS), { rotateBytes: 1024 }));
    logger.info('first');
    await logger.close();
    expect(logger.stats.rotations).toBe(1);
    expect(readFileSync(path.join(dir, 'runtime.log.1'), 'utf8')).toBe(`${'x'.repeat(1023)}\n`);
    expect(readLog(file).map((l) => l['event'])).toEqual(['first']);

    const dir2 = logDir();
    const tiny = createLogger(
      options(path.join(dir2, 'runtime.log'), new FakeClock(FIXTURE_EPOCH_MS), { rotateBytes: 10 }),
    );
    tiny.info('a-line-longer-than-the-limit');
    await tiny.close();
    expect(tiny.stats.rotations).toBe(0);
    expect(names(dir2)).toEqual(['runtime.log']);
  });

  it('uses 10 MiB when rotateBytes is not given', async () => {
    const dir = logDir();
    const file = path.join(dir, 'runtime.log');
    writeFileSync(file, Buffer.alloc(LOG_ROTATE_BYTES - 10, 0x61));
    const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS)));
    logger.info('over');
    await logger.close();
    expect(logger.stats.rotations).toBe(1);
    expect(existsSync(path.join(dir, 'runtime.log.1'))).toBe(true);
  });

  it('with rotate: false only appends, even past the limit, and never renames', async () => {
    const dir = logDir();
    const file = path.join(dir, 'runtime.log');
    writeFileSync(file, `${'y'.repeat(2000)}\n`);
    const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS), { rotate: false, rotateBytes: 1024 }));
    tick(logger, 0, 40);
    await logger.close();
    expect(names(dir)).toEqual(['runtime.log']);
    expect(logger.stats.rotations).toBe(0);
    expect(readFileSync(file, 'utf8').startsWith(`${'y'.repeat(2000)}\n`)).toBe(true);
    expect(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('{')),
    ).toHaveLength(40);
  });
});

// ---- an in-memory file system for the retry schedule -------------------------------------------------------------------

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

const FAKE_DIR = 'L';
const FAKE_LOG = `${FAKE_DIR}/runtime.log`;
const base = (name: string) => name.slice(FAKE_DIR.length + 1);

/** Errors a test queues for the next calls of one operation: `rename <from>`, `unlink <file>`, `append`, `open`. */
type Failures = Map<string, NodeJS.ErrnoException[]>;

class FakeFs {
  /** name -> size in bytes. */
  readonly files = new Map<string, number>();
  /** Every rename and unlink, in order, as `rename a b` / `unlink a` with the folder cut off. */
  readonly calls: string[] = [];
  readonly sleeps: number[] = [];
  readonly stderr: string[] = [];
  readonly appended: string[] = [];
  readonly opens: string[] = [];
  readonly failures: Failures = new Map();
  /** While set, appends wait for it. */
  gate: Promise<void> | null = null;
  /** Milliseconds that count as elapsed inside a failing rename or unlink (a slow disk). */
  slowFailureMs = 0;
  mono = 0;

  readonly deps: LoggerDeps = {
    open: (file) => {
      this.opens.push(base(file));
      const error = this.failures.get('open')?.shift();
      if (error !== undefined) return Promise.reject(error);
      const size = this.files.get(file) ?? 0;
      this.files.set(file, size);
      const opened: LogFile = {
        size,
        append: async (text) => {
          if (this.gate !== null) await this.gate;
          const failure = this.failures.get('append')?.shift();
          if (failure !== undefined) throw failure;
          this.appended.push(text);
          this.files.set(file, (this.files.get(file) ?? 0) + Buffer.byteLength(text));
        },
        close: () => Promise.resolve(),
      };
      return Promise.resolve(opened);
    },
    rename: (from, to) => {
      this.calls.push(`rename ${base(from)} ${base(to)}`);
      const error = this.failures.get(`rename ${base(from)}`)?.shift();
      if (error !== undefined) {
        this.mono += this.slowFailureMs;
        return Promise.reject(error);
      }
      const size = this.files.get(from);
      if (size === undefined) return Promise.reject(errno('ENOENT'));
      this.files.set(to, size);
      this.files.delete(from);
      return Promise.resolve();
    },
    unlink: (file) => {
      this.calls.push(`unlink ${base(file)}`);
      const error = this.failures.get(`unlink ${base(file)}`)?.shift();
      if (error !== undefined) {
        this.mono += this.slowFailureMs;
        return Promise.reject(error);
      }
      if (!this.files.delete(file)) return Promise.reject(errno('ENOENT'));
      return Promise.resolve();
    },
    sleep: (ms) => {
      this.sleeps.push(ms);
      this.mono += ms;
      return Promise.resolve();
    },
    monotonicMs: () => this.mono,
    writeStderr: (text) => {
      this.stderr.push(text);
    },
  };

  fail(key: string, errors: NodeJS.ErrnoException[]): void {
    this.failures.set(key, errors);
  }
}

function fakeFs(): FakeFs {
  return new FakeFs();
}

function fillChain(fs: FakeFs, activeBytes: number): void {
  fs.files.set(FAKE_LOG, activeBytes);
  for (let k = 1; k <= LOG_KEEP; k += 1) fs.files.set(`${FAKE_LOG}.${String(k)}`, 100 * k);
}

function busy(code: string, times: number): NodeJS.ErrnoException[] {
  return Array.from({ length: times }, () => errno(code));
}

function fakeLogger(fs: FakeFs, clock: FakeClock, extra: Partial<LoggerOptions> = {}): Logger {
  return createLoggerWith(options(FAKE_LOG, clock, { rotateBytes: 1000, ...extra }), fs.deps);
}

describe('rotation steps and retries (in-memory file system)', () => {
  it('shifts .4 to .5 down to .1 to .2 after dropping .5, then moves the log to .1', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('over');
    await logger.close();
    expect(fs.calls).toEqual([
      'unlink runtime.log.5',
      'rename runtime.log.4 runtime.log.5',
      'rename runtime.log.3 runtime.log.4',
      'rename runtime.log.2 runtime.log.3',
      'rename runtime.log.1 runtime.log.2',
      'rename runtime.log runtime.log.1',
    ]);
    expect(logger.stats).toEqual({ droppedFields: 0, rotations: 1, rotateFailures: 0, writeFailures: 0 });
    expect(fs.files.get(`${FAKE_LOG}.1`)).toBe(990);
    expect(fs.files.get(`${FAKE_LOG}.5`)).toBe(400);
    expect(fs.files.get(FAKE_LOG)).toBe(Buffer.byteLength(fs.appended.join('')));
    expect(fs.sleeps).toEqual([]);
  });

  it('ignores ENOENT for every missing chain file', async () => {
    const fs = fakeFs();
    fs.files.set(FAKE_LOG, 990);
    fs.files.set(`${FAKE_LOG}.2`, 5);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('over');
    await logger.close();
    expect(fs.calls).toHaveLength(6);
    expect(logger.stats.rotations).toBe(1);
    expect(logger.stats.rotateFailures).toBe(0);
    expect([...fs.files.keys()].sort()).toEqual([FAKE_LOG, `${FAKE_LOG}.1`, `${FAKE_LOG}.3`].sort());
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'retries %s after 50, 100, 200, 250, 250 ms and then succeeds',
    async (code) => {
      const fs = fakeFs();
      fillChain(fs, 990);
      fs.fail('rename runtime.log', busy(code, 5));
      const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
      logger.info('over');
      await logger.close();
      expect(fs.sleeps).toEqual([50, 100, 200, 250, 250]);
      expect(fs.calls.filter((c) => c === 'rename runtime.log runtime.log.1')).toHaveLength(6);
      expect(logger.stats).toEqual({ droppedFields: 0, rotations: 1, rotateFailures: 0, writeFailures: 0 });
    },
  );

  it('retries a busy unlink of .5 the same way', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    fs.fail('unlink runtime.log.5', busy('EBUSY', 2));
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('over');
    await logger.close();
    expect(fs.sleeps).toEqual([50, 100]);
    expect(logger.stats.rotations).toBe(1);
  });

  it('gives up after the 3 s budget: one rotateFailure, the file is reopened and the line is kept', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    fs.fail('rename runtime.log', busy('EBUSY', 1000));
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('kept');
    await logger.close();
    const total = fs.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(LOG_ROTATE_RETRY_BUDGET_MS);
    expect(total - (fs.sleeps.at(-1) ?? 0)).toBeLessThan(LOG_ROTATE_RETRY_BUDGET_MS);
    expect(fs.sleeps.slice(0, 5)).toEqual([50, 100, 200, 250, 250]);
    expect(new Set(fs.sleeps.slice(3)).size).toBe(1);
    expect(logger.stats).toEqual({ droppedFields: 0, rotations: 0, rotateFailures: 1, writeFailures: 0 });
    expect(fs.appended).toHaveLength(1);
    expect(fs.appended[0]).toContain('"event":"kept"');
    expect(fs.files.get(FAKE_LOG)).toBe(990 + Buffer.byteLength(fs.appended.join('')));
    expect(fs.opens).toEqual(['runtime.log', 'runtime.log']);
  });

  it('counts the budget over the whole rotation, not per step', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    fs.fail('unlink runtime.log.5', busy('EBUSY', 4));
    fs.fail('rename runtime.log.4', busy('EBUSY', 1000));
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('over');
    await logger.close();
    const total = fs.sleeps.reduce((a, b) => a + b, 0);
    expect(fs.sleeps.slice(0, 4)).toEqual([50, 100, 200, 250]);
    expect(fs.sleeps.slice(4, 6)).toEqual([50, 100]);
    expect(total).toBeGreaterThanOrEqual(LOG_ROTATE_RETRY_BUDGET_MS);
    expect(total).toBeLessThan(LOG_ROTATE_RETRY_BUDGET_MS + 250);
    expect(logger.stats.rotateFailures).toBe(1);
  });

  it('counts time spent inside failing calls too', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    fs.slowFailureMs = 1000;
    fs.fail('rename runtime.log', busy('EBUSY', 1000));
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('over');
    await logger.close();
    expect(fs.sleeps).toEqual([50, 100]);
    expect(logger.stats.rotateFailures).toBe(1);
  });

  it('does not retry any other error: it fails the rotation at once', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    fs.fail('rename runtime.log.2', [errno('EIO')]);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('kept');
    await logger.close();
    expect(fs.sleeps).toEqual([]);
    expect(logger.stats).toEqual({ droppedFields: 0, rotations: 0, rotateFailures: 1, writeFailures: 0 });
    expect(fs.appended).toHaveLength(1);
    expect(fs.calls).toEqual([
      'unlink runtime.log.5',
      'rename runtime.log.4 runtime.log.5',
      'rename runtime.log.3 runtime.log.4',
      'rename runtime.log.2 runtime.log.3',
    ]);
  });

  it('does not try again for 60 s by the logger clock, then rotates', async () => {
    const fs = fakeFs();
    fillChain(fs, 990);
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    fs.fail('rename runtime.log', busy('EBUSY', 1000));
    const logger = fakeLogger(fs, clock);
    logger.info('first');
    await waitFor(() => logger.stats.rotateFailures === 1);
    const attempts = () => fs.calls.filter((c) => c === 'rename runtime.log runtime.log.1').length;
    const before = attempts();
    fs.failures.clear();
    for (let i = 0; i < 20; i += 1) logger.info('while-paused', { count: i });
    clock.advance(59_999);
    logger.info('still-paused');
    await waitFor(() => fs.appended.length === 22);
    expect(attempts()).toBe(before);
    expect(logger.stats.rotations).toBe(0);
    clock.advance(1);
    logger.info('after-pause');
    await logger.close();
    expect(attempts()).toBe(before + 1);
    expect(logger.stats).toEqual({ droppedFields: 0, rotations: 1, rotateFailures: 1, writeFailures: 0 });
    expect(fs.appended).toHaveLength(23);
  });

  it('with rotate: false never calls rename or unlink', async () => {
    const fs = fakeFs();
    fillChain(fs, 5000);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS), { rotate: false });
    for (let i = 0; i < 10; i += 1) logger.info('x', { count: i });
    await logger.close();
    expect(fs.calls).toEqual([]);
    expect(fs.opens).toEqual(['runtime.log']);
    expect(fs.appended).toHaveLength(10);
  });

  it('tracks the size of the open file from its size at open time plus the bytes it appends', async () => {
    const fs = fakeFs();
    fs.files.set(FAKE_LOG, 800);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    const line = Buffer.byteLength('{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"x"}\n');
    expect(800 + 3 * line).toBeLessThanOrEqual(1000);
    expect(800 + 4 * line).toBeGreaterThan(1000);
    for (let i = 0; i < 3; i += 1) logger.info('x');
    await waitFor(() => fs.appended.length === 3);
    expect(logger.stats.rotations).toBe(0);
    logger.info('x');
    await logger.close();
    expect(logger.stats.rotations).toBe(1);
    expect(fs.files.get(`${FAKE_LOG}.1`)).toBe(800 + 3 * line);
  });
});

describe('write failures and the queue (in-memory file system)', () => {
  it('drops the line of a failed append, counts it, and reopens the file for the next line', async () => {
    const fs = fakeFs();
    fs.fail('append', [errno('EIO')]);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('lost');
    logger.info('kept');
    await logger.close();
    expect(logger.stats.writeFailures).toBe(1);
    expect(fs.appended).toHaveLength(1);
    expect(fs.appended[0]).toContain('"event":"kept"');
    expect(fs.opens).toEqual(['runtime.log', 'runtime.log']);
  });

  it('survives an open that fails and tries again with the next line', async () => {
    const fs = fakeFs();
    fs.fail('open', [errno('EACCES')]);
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    logger.info('lost');
    logger.info('kept');
    await logger.close();
    expect(logger.stats.writeFailures).toBe(1);
    expect(fs.appended).toHaveLength(1);
  });

  it('keeps at most LOG_MAX_QUEUED_LINES waiting and counts the lines it refuses', async () => {
    const fs = fakeFs();
    let release: () => void = () => undefined;
    fs.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const logger = fakeLogger(fs, new FakeClock(FIXTURE_EPOCH_MS));
    const extra = 7;
    for (let i = 0; i < 1 + LOG_MAX_QUEUED_LINES + extra; i += 1) logger.info('flood', { count: i });
    expect(logger.stats.writeFailures).toBe(extra);
    release();
    await logger.close();
    expect(fs.appended).toHaveLength(1 + LOG_MAX_QUEUED_LINES);
    expect(logger.stats.writeFailures).toBe(extra);
  });

  it('writes to stderr only, in call order, when file is null, and survives a failing stderr', () => {
    const fs = fakeFs();
    const logger = createLoggerWith(options(null, new FakeClock(FIXTURE_EPOCH_MS), { level: 'warn' }), fs.deps);
    logger.info('hidden');
    logger.warn('one', { count: 1 });
    logger.error('two', { count: 2 });
    expect(fs.stderr).toEqual([
      '{"ts":"2026-01-01T00:00:00.000Z","level":"warn","event":"one","count":1}\n',
      '{"ts":"2026-01-01T00:00:00.000Z","level":"error","event":"two","count":2}\n',
    ]);
    expect(fs.opens).toEqual([]);
    const throwing = createLoggerWith(options(null, new FakeClock(FIXTURE_EPOCH_MS)), {
      ...fs.deps,
      writeStderr: () => {
        throw errno('EPIPE');
      },
    });
    expect(() => {
      throwing.error('x');
    }).not.toThrow();
    expect(throwing.stats.writeFailures).toBe(1);
  });

  it('never throws when the clock returns a time that has no ISO form', async () => {
    const fs = fakeFs();
    const brokenClock = { now: () => Number.NaN };
    const logger = createLoggerWith({ file: FAKE_LOG, level: 'debug', rotate: true, clock: brokenClock }, fs.deps);
    expect(() => {
      logger.info('x');
    }).not.toThrow();
    await logger.close();
    expect(logger.stats.writeFailures).toBe(1);
    expect(fs.appended).toEqual([]);
  });
});

// ---- a real holder of the file (win32: a PowerShell child opens without FILE_SHARE_DELETE, E23) -------------------------

const heldSkip: string | null = FILE_HOLDER_SKIP_REASON === null ? null : `skipped: ${FILE_HOLDER_SKIP_REASON}`;

/** Holds `file` for `seconds` in another process; only called where `heldSkip` is null. */
async function holdFile(file: string, seconds: number): Promise<FileHolder> {
  const holder = await holdFileOpen(file, seconds * 1000);
  if (holder === null) throw new Error('holdFileOpen: not supported on this platform');
  return holder;
}

describe('rotation while another program holds the file (S-LOG-6, E23)', () => {
  const fill = (n: number) => Buffer.alloc(n, 0x61).toString('latin1');

  it.skipIf(heldSkip !== null)(
    `rotation succeeds after retries when the file is held for 500 ms (${heldSkip ?? 'win32'})`,
    async () => {
      const root = makeTemp('logger-held').path;
      const dir = path.join(root, 'logs');
      mkdirSync(dir);
      const file = path.join(dir, 'runtime.log');
      writeFileSync(file, `${fill(1000)}\n`);
      const holder = await holdFile(file, 0.5);
      try {
        const logger = createLogger(options(file, new FakeClock(FIXTURE_EPOCH_MS), { rotateBytes: 1024 }));
        for (let i = 0; i < 5; i += 1) logger.info('line', { count: i });
        await logger.close();
        expect(logger.stats).toEqual({ droppedFields: 0, rotations: 1, rotateFailures: 0, writeFailures: 0 });
        expect(readFileSync(path.join(dir, 'runtime.log.1'), 'utf8')).toBe(`${fill(1000)}\n`);
        expect(readLog(file).map((l) => l['count'])).toEqual([0, 1, 2, 3, 4]);
      } finally {
        await holder.stop();
      }
    },
    20_000,
  );

  it.skipIf(heldSkip !== null)(
    `a file held past the budget fails once, loses no line and is not retried for 60 s (${heldSkip ?? 'win32'})`,
    async () => {
      const root = makeTemp('logger-held').path;
      const dir = path.join(root, 'logs');
      mkdirSync(dir);
      const file = path.join(dir, 'runtime.log');
      writeFileSync(file, `${fill(1000)}\n`);
      const holder = await holdFile(file, 30);
      const clock = new FakeClock(FIXTURE_EPOCH_MS);
      const written = () => parseLines(readFileSync(file, 'utf8').slice(1001)).map((l) => l['count']);
      try {
        const logger = createLogger(options(file, clock, { rotateBytes: 1024 }));
        for (let i = 0; i < 5; i += 1) logger.info('line', { count: i });
        await waitFor(() => logger.stats.rotateFailures === 1, { timeoutMs: 15_000, what: 'the failed rotation' });
        expect(logger.stats.rotations).toBe(0);
        for (let i = 5; i < 10; i += 1) logger.info('line', { count: i });
        await holder.stop();
        for (let i = 10; i < 15; i += 1) logger.info('line', { count: i });
        clock.advance(59_999);
        for (let i = 15; i < 20; i += 1) logger.info('line', { count: i });
        await waitFor(() => written().length === 20, { what: 'the 20 lines' });
        expect(logger.stats).toEqual({ droppedFields: 0, rotations: 0, rotateFailures: 1, writeFailures: 0 });
        expect(existsSync(path.join(dir, 'runtime.log.1'))).toBe(false);
        expect(readFileSync(file, 'utf8').startsWith(`${fill(1000)}\n`)).toBe(true);
        expect(written()).toEqual(Array.from({ length: 20 }, (_v, i) => i));

        clock.advance(1);
        logger.info('after');
        await logger.close();
        expect(logger.stats).toEqual({ droppedFields: 0, rotations: 1, rotateFailures: 1, writeFailures: 0 });
        expect(readFileSync(path.join(dir, 'runtime.log.1'), 'utf8').startsWith(`${fill(1000)}\n`)).toBe(true);
        expect(readLog(file).map((l) => l['event'])).toEqual(['after']);
      } finally {
        await holder.stop();
      }
    },
    30_000,
  );

  it.skipIf(heldSkip !== null)(
    `rotate: false does not rename even when the file is held (${heldSkip ?? 'win32'})`,
    async () => {
      const root = makeTemp('logger-held').path;
      const dir = path.join(root, 'logs');
      mkdirSync(dir);
      const file = path.join(dir, 'runtime.log');
      writeFileSync(file, `${fill(2000)}\n`);
      const holder = await holdFile(file, 30);
      try {
        const logger = createLogger(
          options(file, new FakeClock(FIXTURE_EPOCH_MS), { rotate: false, rotateBytes: 1024 }),
        );
        for (let i = 0; i < 5; i += 1) logger.info('line', { count: i });
        await logger.close();
        expect(logger.stats).toEqual({ droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 });
        expect(readdirSync(dir)).toEqual(['runtime.log']);
      } finally {
        await holder.stop();
      }
    },
    20_000,
  );
});
