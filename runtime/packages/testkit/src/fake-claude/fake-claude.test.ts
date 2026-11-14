// Self-tests of the fake claude in pipe mode (design 08, section 2.6): TC-FAKE-01..13. The raw-mode behaviour, the size reports and
// the shim chain need a real terminal and are proven by the real-PTY suites. The fake is started directly, never through a shim.
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CANARY } from '../canary.ts';
import { FIXTURE_EPOCH_MS } from '../clock.ts';
import { hermeticEnv } from '../isolation.ts';
import { useTempDirs } from '../temp.ts';
import { TranscriptBuilder, detUuid, projectDirName } from '../transcript.ts';
import { waitFor } from '../wait.ts';
import {
  BRACKETED_PASTE_ON,
  BURST_DEFAULT_LINE_BYTES,
  FAKE_BANNER,
  FAKE_CRASH_CODE,
  FAKE_DEFAULT_SEED,
  FAKE_PROMPT,
  HOSTILE_LONG_LINE_BYTES,
  SAFE_ENV_NAMES,
  TAG,
  UTF8_UNIT,
  burstExpected,
  burstLine,
  coalesceStdin,
  fakeSessionId,
  fnv1a32,
  fnv1a32Hex,
  parseFakeLog,
  parseReady,
  type FakeLogEntry,
} from './protocol.ts';

const SCRIPT = fileURLToPath(new URL('../../assets/fake-claude.mjs', import.meta.url));
const tempDir = useTempDirs();
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const NEEDLE_ARGV = 'FIXTURE-ARGV-NEEDLE-0001';

interface FakeOptions {
  args?: string[];
  env?: Record<string, string>;
  root?: string;
  cwd?: string;
}

interface Fake {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly root: string;
  readonly claudeHome: string;
  readonly logPath: string;
  text(): string;
  send(data: string | Buffer): void;
  end(): void;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  bytes(): Buffer;
  stderr(): string;
}

const started = new Map<ChildProcess, Promise<unknown>>();

// Declared after `tempDir`, so it runs first: a process that is still alive holds its working folder on Windows.
afterEach(async () => {
  const all = [...started];
  started.clear();
  for (const [child] of all) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(all.map(([, closed]) => closed));
});

function startFake(opts: FakeOptions = {}): Fake {
  const root = opts.root ?? tempDir('fake-claude').path;
  const logPath = join(root, 'fake.log');
  const env: Record<string, string> = { ...hermeticEnv(root), FAKE_CLAUDE_LOG: logPath, ...opts.env };
  const child = spawn(process.execPath, [SCRIPT, ...(opts.args ?? [])], {
    cwd: opts.cwd ?? root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.stdin.on('error', () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
  started.set(child, exited);
  return {
    child,
    root,
    claudeHome: join(root, 'claude-home'),
    logPath,
    text: () => Buffer.concat(out).toString('utf8'),
    bytes: () => Buffer.concat(out),
    stderr: () => Buffer.concat(err).toString('utf8'),
    send: (data) => {
      child.stdin.write(data);
    },
    end: () => {
      child.stdin.end();
    },
    exited,
  };
}

interface Run {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly text: string;
  readonly bytes: Buffer;
  readonly stderr: string;
  readonly root: string;
  readonly claudeHome: string;
  readonly log: FakeLogEntry[];
  readonly logText: string;
}

/** Runs the fake to its end: `input` goes to stdin in one write, then stdin is closed. */
async function runFake(input: string | Buffer, opts: FakeOptions = {}): Promise<Run> {
  const fake = startFake(opts);
  fake.child.stdin.end(input);
  const { code, signal } = await fake.exited;
  const logText = existsSync(fake.logPath) ? readFileSync(fake.logPath, 'utf8') : '';
  return {
    code,
    signal,
    text: fake.text(),
    bytes: fake.bytes(),
    stderr: fake.stderr(),
    root: fake.root,
    claudeHome: fake.claudeHome,
    log: parseFakeLog(logText),
    logText,
  };
}

const stripAnsi = (text: string): string => text.replace(ANSI, '');
const answers = (text: string): string[] =>
  stripAnsi(text)
    .split('\r\n')
    .filter((line) => line !== '' && line !== FAKE_PROMPT);
/** The answers after the two banner lines. */
const afterBanner = (text: string): string[] => answers(text).slice(2);

function readJsonLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not a record');
      return Object.fromEntries(Object.entries(value));
    });
}

function readJsonFile(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

const sortedKeys = (value: unknown): string[] => Object.keys(asRecord(value)).sort();

function tagValue(text: string, tag: string): string {
  const line = answers(text).find((candidate) => candidate.startsWith(tag));
  if (line === undefined) throw new Error(`no ${tag} line in the output`);
  return line.slice(tag.length);
}

describe('fake claude protocol helpers', () => {
  it('computes FNV-1a 32 like the reference vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32Hex('a')).toBe('e40c292c');
    expect(fnv1a32(Buffer.from('foobar'))).toBe(0xbf9cf968);
  });

  it('builds burst lines of the exact size, different per sequence number', () => {
    for (const bytes of [12, 50, 100, 1000]) {
      const line = burstLine(7, bytes);
      expect(Buffer.byteLength(line)).toBe(bytes);
      expect(line.startsWith('B000007:')).toBe(true);
      expect(line.endsWith('\r\n')).toBe(true);
    }
    expect(burstLine(0)).not.toBe(burstLine(1));
    expect(() => burstLine(-1)).toThrow(RangeError);
    expect(() => burstLine(1_000_000)).toThrow(RangeError);
    expect(() => burstLine(0, 11)).toThrow(RangeError);
  });

  it('plans a burst by size', () => {
    const plan = burstExpected(64);
    expect(plan.lines).toBe(Math.floor((64 * 1024) / BURST_DEFAULT_LINE_BYTES));
    expect(plan.bytes).toBe(plan.lines * BURST_DEFAULT_LINE_BYTES);
    expect(Buffer.byteLength(plan.text)).toBe(plan.bytes);
    expect(plan.done).toBe(`BURST-DONE:${String(plan.lines)}:${fnv1a32Hex(plan.text)}`);
    expect(burstExpected(0).lines).toBe(Math.floor(1024 / BURST_DEFAULT_LINE_BYTES));
  });

  it('parses a READY line with and without a terminal', () => {
    expect(
      parseReady('Claude Code (fake) 0.0.0-test\r\nREADY pid=42 cols=120 rows=30 args=["--a","b c"]\r\n> '),
    ).toEqual({
      pid: 42,
      cols: 120,
      rows: 30,
      args: ['--a', 'b c'],
    });
    expect(parseReady('READY pid=7 cols=unknown rows=unknown args=[]')).toEqual({
      pid: 7,
      cols: null,
      rows: null,
      args: [],
    });
    expect(parseReady('nothing here')).toBeNull();
    expect(parseReady('READY pid=7 cols=1 rows=1 args={}')).toBeNull();
  });

  it('parses a log and merges adjacent stdin entries', () => {
    const text = [
      '{"n":1,"ev":"start","argv":[],"env":[]}',
      '{"n":2,"ev":"stdin","hex":"6162"}',
      '{"n":3,"ev":"stdin","hex":"63"}',
      '{"n":4,"ev":"cmd","name":"text","args":1}',
      '{"n":5,"ev":"stdin","hex":"0a"}',
      '',
    ].join('\n');
    const entries = parseFakeLog(text);
    expect(entries).toHaveLength(5);
    const merged = coalesceStdin(entries);
    expect(merged.map((entry) => entry.ev)).toEqual(['start', 'stdin', 'cmd', 'stdin']);
    expect(merged.map((entry) => entry.n)).toEqual([1, 2, 3, 4]);
    expect(merged[1]?.['hex']).toBe('616263');
    expect(entries[1]?.['hex']).toBe('6162');
    expect(() => parseFakeLog('{"n":1,"ev":"bogus"}')).toThrow(/not a fake claude log entry/);
    expect(() => parseFakeLog('not json')).toThrow();
  });

  it('derives the default session id from the seed like the transcript builder does', () => {
    expect(fakeSessionId()).toBe(detUuid(FAKE_DEFAULT_SEED, 'session-0'));
    expect(fakeSessionId('other')).toBe(detUuid('other', 'session-0'));
    expect(fakeSessionId('other')).not.toBe(fakeSessionId());
  });
});

describe('fake claude script', () => {
  it('agrees with protocol.ts on every tag and constant', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    for (const [key, value] of Object.entries(TAG)) expect(source, `tag ${key}`).toContain(value);
    for (const name of SAFE_ENV_NAMES) expect(source, `safe env name ${name}`).toContain(name);
    expect(source).toContain(FAKE_BANNER);
    expect(source).toContain(FAKE_DEFAULT_SEED);
  });

  it('imports only Node built-ins and no repository code', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const specifiers = [...source.matchAll(/^import[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier, 'import specifier').toMatch(/^node:/);
    expect(source).not.toMatch(/\bimport\(/);
  });

  it('prints a PATH line for --install and keeps quiet about everything else', async () => {
    const dir = join(tempDir('fake-install').path, 'bin');
    const run = await runFake('', { args: ['--install', dir] });
    expect(run.code).toBe(0);
    const text = run.text.trim();
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toContain(dir);
    expect(text).toMatch(process.platform === 'win32' ? /^set "PATH=/ : /^export PATH=/);
    expect(existsSync(join(dir, 'fake-claude.mjs'))).toBe(true);
    expect(run.text).not.toContain(TAG.ready);
  });

  it('refuses --install without a folder', async () => {
    const run = await runFake('', { args: ['--install'] });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('usage');
  });
});

describe('fake claude pipe mode', () => {
  it('TC-FAKE-01 prints the banner and READY, echoes text and keeps the prompt', async () => {
    const run = await runFake('hello world\n\n');
    expect(run.code).toBe(0);
    expect(run.text.startsWith(`${BRACKETED_PASTE_ON}${FAKE_BANNER}\r\n`)).toBe(true);
    const ready = parseReady(run.text);
    expect(ready).not.toBeNull();
    expect(ready?.cols).toBeNull();
    expect(ready?.args).toEqual([]);
    expect(afterBanner(run.text)).toEqual(['ECHO:hello world']);
    expect(run.text.endsWith(FAKE_PROMPT)).toBe(true);
  });

  it('TC-FAKE-01 handles Backspace, Tab, Ctrl+C and Ctrl+D', async () => {
    const run = await runFake('ab\x7fc\nx\ty\nabc\x03def\nkeep\x04\n');
    expect(run.code).toBe(0);
    const lines = afterBanner(run.text);
    expect(lines).toContain('ECHO:ac');
    expect(lines).toContain(TAG.tab);
    expect(lines).toContain('ECHO:xy');
    expect(lines.some((candidate) => candidate.endsWith('^C'))).toBe(true);
    expect(lines).toContain(TAG.interrupt);
    expect(lines).toContain('ECHO:def');
    expect(lines).not.toContain('ECHO:abcdef');
    expect(lines).toContain('ECHO:keep');
    const eof = await runFake('\x04ignored\n');
    expect(eof.code).toBe(0);
    expect(afterBanner(eof.text)).toEqual([]);
  });

  it('TC-FAKE-01 ends a line at CR, LF or CRLF (a pair counts once) and reports an unknown command', async () => {
    const run = await runFake('a\r\nb\rc\n/nope with words\n/echo ' + UTF8_UNIT + ' wide\n');
    expect(afterBanner(run.text)).toEqual(['ECHO:a', 'ECHO:b', 'ECHO:c', 'UNKNOWN:nope', `${UTF8_UNIT} wide`]);
  });

  it('TC-FAKE-01 treats the last line without a line end as a line', async () => {
    const run = await runFake('tail');
    expect(afterBanner(run.text)).toEqual(['ECHO:tail']);
    expect(run.code).toBe(0);
  });

  it('TC-FAKE-02 /colors writes the sixteen, the 256 and the true colour samples', async () => {
    const run = await runFake('/colors\n');
    const text = run.text;
    for (let i = 0; i < 8; i += 1) {
      expect(text).toContain(`${ESC}[${String(30 + i)}m`);
      expect(text).toContain(`${ESC}[${String(90 + i)}m`);
      expect(text).toContain(`${ESC}[${String(40 + i)}m`);
      expect(text).toContain(`${ESC}[${String(100 + i)}m`);
    }
    for (let i = 0; i < 256; i += 1) expect(text).toContain(`${ESC}[38;5;${String(i)}m`);
    const truecolor = new Set(
      [...text.matchAll(new RegExp(`${ESC}\\[38;2;(\\d+);(\\d+);(\\d+)m`, 'g'))].map((m) => m[0]),
    );
    expect(truecolor.size).toBeGreaterThanOrEqual(16);
    expect(afterBanner(run.text).at(-1)).toBe(TAG.colorsDone);
  });

  it('TC-FAKE-03 /size answers unknown without a terminal', async () => {
    const run = await runFake('/size\n');
    expect(afterBanner(run.text)).toEqual(['SIZE:unknown']);
    expect(parseReady(run.text)?.rows).toBeNull();
  });

  it('TC-FAKE-04 /burst writes numbered lines and a checksum the test can recompute', async () => {
    const run = await runFake('/burst 64\n');
    const expected = burstExpected(64);
    const lines = afterBanner(run.text);
    expect(lines.at(-1)).toBe(expected.done);
    const body = lines.slice(0, -1);
    expect(body).toHaveLength(expected.lines);
    // The test recomputes the checksum from the bytes it received, never from the oracle.
    const received = body.map((line) => `${line}\r\n`).join('');
    expect(Buffer.byteLength(received)).toBe(expected.bytes);
    expect(`${TAG.burstDone}${String(body.length)}:${fnv1a32Hex(received)}`).toBe(expected.done);
    expect(received).toBe(expected.text);
    body.forEach((line, seq) => {
      expect(line.startsWith(`B${String(seq).padStart(6, '0')}:`)).toBe(true);
    });
  });

  it('TC-FAKE-04 /big is an alias and the line size is an argument', async () => {
    const run = await runFake('/big 4\n/burst 8 50\n');
    const four = burstExpected(4);
    const eight = burstExpected(8, 50);
    const lines = afterBanner(run.text);
    expect(lines).toContain(four.done);
    expect(lines).toContain(eight.done);
    expect(
      lines.filter((line) => line.startsWith('B0')).every((line) => line.length === 98 || line.length === 48),
    ).toBe(true);
  });

  it('TC-FAKE-04 /burst clamps its arguments and /utf8 writes one byte per write', async () => {
    const run = await runFake('/burst 0 3\n/utf8 3\n');
    const lines = afterBanner(run.text);
    const clamped = burstExpected(0, 3);
    expect(lines).toContain(clamped.done);
    expect(lines).toContain(UTF8_UNIT.repeat(3));
    expect(lines).toContain(`${TAG.utf8Done}3`);
  });

  it('TC-FAKE-05 exits with the code it is given and always delivers BYE first', async () => {
    const cases: { input: string; code: number; tag: string | null }[] = [
      { input: '/exit\n', code: 0, tag: 'BYE:0' },
      { input: '/exit 5\n', code: 5, tag: 'BYE:5' },
      { input: '/exit 300\n', code: 255, tag: 'BYE:255' },
      { input: '/exit nope\n', code: 0, tag: 'BYE:0' },
      { input: '/crash\n', code: FAKE_CRASH_CODE, tag: TAG.crash },
      { input: '/crash 9\n', code: 9, tag: TAG.crash },
      { input: '/exit-now 4\n', code: 4, tag: null },
    ];
    for (const { input, code, tag } of cases) {
      const run = await runFake(`${input}ignored after exit\n`);
      expect(run.code, input).toBe(code);
      expect(run.signal, input).toBeNull();
      if (tag !== null) expect(afterBanner(run.text), input).toContain(tag);
      expect(afterBanner(run.text), input).not.toContain('ECHO:ignored after exit');
    }
    const quick = await runFake('/exit-now 4\n');
    expect(quick.text).not.toContain('BYE');
  });

  it('TC-FAKE-05 drains a long answer before /exit, /crash and the end of input', async () => {
    const run = await runFake('/burst 256\n/exit 6\n');
    expect(run.code).toBe(6);
    const lines = afterBanner(run.text);
    const done = burstExpected(256).done;
    expect(lines.indexOf(done)).toBeGreaterThan(0);
    expect(lines.indexOf('BYE:6')).toBe(lines.indexOf(done) + 1);
    const ended = await runFake('/burst 64\n');
    expect(afterBanner(ended.text).at(-1)).toBe(burstExpected(64).done);
    expect(ended.code).toBe(0);
  });

  it('TC-FAKE-05 /last-words writes its tag and exits 0 in the same tick, without waiting for the end of input', async () => {
    // stdin stays open: only the command itself can end the process, and the line behind it is never read.
    const fake = startFake();
    fake.send('first\n/last-words\nafter the end\n');
    await waitFor(() => fake.child.exitCode !== null || fake.child.signalCode !== null, {
      what: 'the fake to exit by itself after /last-words',
    });
    const { code, signal } = await fake.exited;
    expect(signal).toBeNull();
    expect(code).toBe(0);
    // The number counts the lines handled so far: the text line and /last-words itself.
    expect(afterBanner(fake.text())).toEqual(['ECHO:first', 'LAST-WORDS:2']);
    expect(fake.text()).not.toContain('after the end');
    expect(fake.text().endsWith(`${TAG.lastWords}2\r\n`)).toBe(true);
    const log = parseFakeLog(readFileSync(fake.logPath, 'utf8'));
    const handled = log.filter((entry) => entry.ev === 'cmd').map((entry) => String(entry['name']));
    expect(handled).toEqual(['text', '/last-words']);
    expect(log.at(-1)).toMatchObject({ ev: 'exit', code: 0 });
  });

  it('TC-FAKE-05 /throw fails with code 1 and an error on stderr', async () => {
    const thrown = await runFake('/throw\n');
    expect(thrown.code).toBe(1);
    expect(thrown.stderr).toContain('fake-claude');
    expect(thrown.log.at(-1)).toMatchObject({ ev: 'exit', code: 1 });
  });

  it('TC-FAKE-06 /env prints safe values, set or UNSET for the rest, and never a secret', async () => {
    const run = await runFake('/env CLAUDECODE TERM FIXTURE_CANARY_VAR NOT_SET_VAR NO_COLOR bad-name\n', {
      env: { FIXTURE_CANARY_VAR: CANARY.envToken, CLAUDECODE: '1', TERM: 'xterm-256color' },
    });
    expect(afterBanner(run.text)).toEqual([
      'ENV:CLAUDECODE=1',
      'ENV:TERM=xterm-256color',
      'ENV:FIXTURE_CANARY_VAR=set',
      'ENV:NOT_SET_VAR=UNSET',
      'ENV:NO_COLOR=UNSET',
      'ENV:INVALID',
    ]);
    expect(run.text).not.toContain(CANARY.envToken);
  });

  it('TC-FAKE-06 /envnames lists names only and /envscan looks through values and argv without echoing them', async () => {
    const run = await runFake(
      `/envnames FIXTURE_\n/envnames MCS_\n/envscan ${CANARY.envToken}\n/envscan FIXTURE-CANARY-NEVER-SET-0001\n/envscan ${NEEDLE_ARGV}\n/envscan abc\n`,
      { env: { FIXTURE_CANARY_VAR: CANARY.envToken, FIXTURE_OTHER: 'x' }, args: [`--token=${NEEDLE_ARGV}`] },
    );
    const lines = afterBanner(run.text);
    expect(lines[0]).toBe('ENVNAMES:FIXTURE_:FIXTURE_CANARY_VAR,FIXTURE_OTHER');
    expect(lines[1]?.startsWith('ENVNAMES:MCS_:')).toBe(true);
    expect(lines[1]).toContain('MCS_HOOK_DISABLE');
    expect(lines.slice(2)).toEqual(['ENVSCAN:FOUND', 'ENVSCAN:ABSENT', 'ENVSCAN:FOUND', 'ENVSCAN:TOO-SHORT']);
    expect(run.text).not.toContain(CANARY.envToken);
    expect(run.text).not.toContain('FIXTURE-CANARY-NEVER-SET-0001');
    expect(run.stderr).toBe('');
  });

  it('TC-FAKE-07 /args, /cwd and /pid report the argument vector, the folder and the process ids', async () => {
    const root = tempDir('fake-args').path;
    const folder = join(root, 'cwd dir');
    mkdirSync(folder);
    const args = ['--resume', 'abc', 'a b', '--flag=é', ''];
    const run = await runFake('/args\n/cwd\n/pid\n', { args, root, cwd: folder });
    const lines = afterBanner(run.text);
    expect(JSON.parse(tagValue(run.text, TAG.args))).toEqual(args);
    expect(realpathSync.native(tagValue(run.text, TAG.cwd))).toBe(realpathSync.native(folder));
    const ready = parseReady(run.text);
    expect(ready?.args).toEqual(args);
    expect(lines.find((line) => line.startsWith(TAG.pid))).toBe(
      `PID:${String(ready?.pid)} PPID:${String(process.pid)}`,
    );
  });

  it('TC-FAKE-08 /transcript writes two turns with stable record ids', async () => {
    const root = tempDir('fake-transcript').path;
    const project = join(root, 'FIXTURE project', 'app');
    const run = await runFake(`/transcript 2 ${project}\n`, { root });
    const id = fakeSessionId();
    expect(tagValue(run.text, TAG.transcript)).toBe(id);
    const file = join(run.claudeHome, 'projects', projectDirName(project), `${id}.jsonl`);
    const records = readJsonLines(file);
    expect(records.map((record) => record['type'])).toEqual(['user', 'assistant', 'user', 'assistant']);
    for (const record of records) {
      expect(record['sessionId']).toBe(id);
      expect(record['cwd']).toBe(project);
      expect(typeof record['uuid']).toBe('string');
      expect(typeof record['timestamp']).toBe('string');
    }
    expect(records[0]?.['parentUuid']).toBeNull();
    records.slice(1).forEach((record, index) => {
      expect(record['parentUuid']).toBe(records[index]?.['uuid']);
    });
    const assistants = records.filter((record) => record['type'] === 'assistant');
    const messageIds = assistants.map((record) => asRecord(record['message'])['id']);
    expect(new Set(messageIds).size).toBe(2);
    for (const record of assistants) {
      const message = asRecord(record['message']);
      const usage = asRecord(message['usage']);
      expect(usage['input_tokens']).toBe(100);
      expect(usage['output_tokens']).toBe(20);
      expect(message['stop_reason']).toBe('end_turn');
    }
    // The ids are stable: a second run in another home writes the same message ids.
    const again = await runFake(`/transcript 2 ${project}\n`);
    const second = readJsonLines(join(again.claudeHome, 'projects', projectDirName(project), `${id}.jsonl`));
    expect(second.filter((r) => r['type'] === 'assistant').map((r) => asRecord(r['message'])['id'])).toEqual(
      messageIds,
    );
    expect(second.map((r) => r['uuid'])).toEqual(records.map((r) => r['uuid']));
  });

  it('TC-FAKE-08 the transcript records have the key sets of the transcript builder', async () => {
    const root = tempDir('fake-shapes').path;
    const project = join(root, 'FIXTURE project');
    const run = await runFake(`/transcript 1 ${project}\n`, { root });
    const id = fakeSessionId();
    const written = readJsonLines(join(run.claudeHome, 'projects', projectDirName(project), `${id}.jsonl`));
    const builderFile = join(root, 'builder.jsonl');
    new TranscriptBuilder({ sessionId: id, cwd: project, startMs: FIXTURE_EPOCH_MS })
      .user()
      .assistant({ messageId: 'msg_fixture_shape' })
      .write(builderFile);
    const reference = readJsonLines(builderFile);
    expect(sortedKeys(written[0])).toEqual(sortedKeys(reference[0]));
    expect(sortedKeys(written[1])).toEqual(sortedKeys(reference[1]));
    expect(sortedKeys(asRecord(written[0]?.['message']))).toEqual(sortedKeys(asRecord(reference[0]?.['message'])));
    expect(sortedKeys(asRecord(written[1]?.['message']))).toEqual(sortedKeys(asRecord(reference[1]?.['message'])));
    expect(sortedKeys(asRecord(asRecord(written[1]?.['message'])['usage']))).toEqual(
      sortedKeys(asRecord(asRecord(reference[1]?.['message'])['usage'])),
    );
    expect(written[0]?.['uuid']).toBe(reference[0]?.['uuid']);
  });

  it('TC-FAKE-08 the registry entry has the fields the engine reader and the linker need', async () => {
    const root = tempDir('fake-registry').path;
    const project = join(root, 'FIXTURE project');
    mkdirSync(project, { recursive: true });
    const before = Date.now();
    const run = await runFake(`/transcript 1 ${project}\n`, { root, env: { FAKE_CLAUDE_KEEP_REGISTRY: '1' } });
    const after = Date.now();
    const pid = parseReady(run.text)?.pid ?? 0;
    const file = join(run.claudeHome, 'sessions', `${String(pid)}.json`);
    const entry = readJsonFile(file);
    expect(Object.keys(entry).sort()).toEqual(['cwd', 'kind', 'pid', 'sessionId', 'startedAt', 'status']);
    expect(entry['pid']).toBe(pid);
    expect(entry['sessionId']).toBe(fakeSessionId());
    expect(entry['status']).toBe('idle');
    expect(entry['cwd']).toBe(project);
    expect(entry['kind']).toBe('interactive');
    expect(typeof entry['startedAt']).toBe('number');
    expect(Number(entry['startedAt'])).toBeGreaterThanOrEqual(before - 5000);
    expect(Number(entry['startedAt'])).toBeLessThanOrEqual(after);
  });

  it('TC-FAKE-08 /status rewrites the registry entry, /rewrite-id changes the session id and the transcript file', async () => {
    const root = tempDir('fake-status').path;
    const project = join(root, 'FIXTURE project');
    const next = detUuid('rewrite-target', 1);
    const run = await runFake(
      [
        `/transcript 1 ${project}`,
        '/status waiting approve the plan',
        '/status bogus',
        `/rewrite-id ${next}`,
        '/rewrite-id not-a-uuid',
        '/status busy',
        '',
      ].join('\n'),
      { root, env: { FAKE_CLAUDE_KEEP_REGISTRY: '1' } },
    );
    const lines = afterBanner(run.text);
    expect(lines).toContain('STATUS:waiting');
    expect(lines).toContain(`${TAG.error}status`);
    expect(lines).toContain(`${TAG.rewrote}${next}`);
    expect(lines).toContain(`${TAG.error}session-id`);
    const pid = parseReady(run.text)?.pid ?? 0;
    const entry = readJsonFile(join(run.claudeHome, 'sessions', `${String(pid)}.json`));
    expect(entry['sessionId']).toBe(next);
    expect(entry['status']).toBe('busy');
    expect('waitingFor' in entry).toBe(false);
    const dir = join(run.claudeHome, 'projects', projectDirName(project));
    expect(readdirSync(dir).sort()).toEqual([`${fakeSessionId()}.jsonl`, `${next}.jsonl`].sort());
    expect(readJsonLines(join(dir, `${next}.jsonl`)).length).toBeGreaterThanOrEqual(2);
    const waiting = await runFake('/transcript 1\n/status waiting approve the plan\n', {
      env: { FAKE_CLAUDE_KEEP_REGISTRY: '1' },
    });
    const waitingPid = parseReady(waiting.text)?.pid ?? 0;
    const kept = readJsonFile(join(waiting.claudeHome, 'sessions', `${String(waitingPid)}.json`));
    expect(kept['status']).toBe('waiting');
    expect(kept['waitingFor']).toBe('approve the plan');
  });

  it('TC-FAKE-08 /rewrite-id rewrites the registry entry of a running fake and keeps its other fields', async () => {
    // No /status after the rewrite: the entry on disk must carry the new id because /rewrite-id wrote it, not a later command.
    const root = tempDir('fake-rewrite').path;
    const project = join(root, 'FIXTURE project');
    const next = detUuid('rewrite-registry', 1);
    const fake = startFake({ root });
    const file = join(fake.claudeHome, 'sessions', `${String(fake.child.pid)}.json`);
    fake.send(`/transcript 1 ${project}\n/status waiting approve the plan\n`);
    await waitFor(() => fake.text().includes('STATUS:waiting'), { what: 'the status answer' });
    const before = readJsonFile(file);
    expect(before['sessionId']).toBe(fakeSessionId());
    fake.send(`/rewrite-id ${next}\n`);
    await waitFor(() => fake.text().includes(`${TAG.rewrote}${next}`), { what: 'the rewrite answer' });
    const after = readJsonFile(file);
    expect(after['sessionId']).toBe(next);
    expect(after).toEqual({ ...before, sessionId: next });
    expect(after['status']).toBe('waiting');
    expect(after['waitingFor']).toBe('approve the plan');
    fake.send('/exit\n');
    expect((await fake.exited).code).toBe(0);
  });

  it('TC-FAKE-08 /rewrite-id writes the registry only for a registered fake and the transcript only for a continued one', async () => {
    const root = tempDir('fake-rewrite-scope').path;
    const next = detUuid('rewrite-scope', 1);
    const bare = await runFake(`/rewrite-id ${next}\n/rewrite-id not-a-uuid\n`, {
      root,
      env: { FAKE_CLAUDE_KEEP_REGISTRY: '1' },
    });
    expect(afterBanner(bare.text)).toEqual([`${TAG.rewrote}${next}`, `${TAG.error}session-id`]);
    expect(existsSync(join(bare.claudeHome, 'sessions'))).toBe(false);
    expect(existsSync(join(bare.claudeHome, 'projects'))).toBe(false);
    const registered = await runFake(`/rewrite-id ${next}\n`, {
      root,
      env: { FAKE_CLAUDE_AUTOREGISTER: '1', FAKE_CLAUDE_KEEP_REGISTRY: '1' },
    });
    const pid = parseReady(registered.text)?.pid ?? 0;
    expect(readJsonFile(join(registered.claudeHome, 'sessions', `${String(pid)}.json`))['sessionId']).toBe(next);
    expect(existsSync(join(registered.claudeHome, 'projects'))).toBe(false);
  });

  it('TC-FAKE-08 --resume adopts the id, --fork-session and FAKE_CLAUDE_SEED choose another one', async () => {
    const resumed = detUuid('resume-source', 1);
    const adopt = await runFake('/transcript 1\n', { args: ['--resume', resumed] });
    expect(tagValue(adopt.text, TAG.transcript)).toBe(resumed);
    const eq = await runFake('/transcript 1\n', { args: [`--resume=${resumed}`] });
    expect(tagValue(eq.text, TAG.transcript)).toBe(resumed);
    const fork = await runFake('/transcript 1\n', { args: ['--resume', resumed, '--fork-session'] });
    expect(tagValue(fork.text, TAG.transcript)).toBe(fakeSessionId());
    const seeded = await runFake('/transcript 1\n', { env: { FAKE_CLAUDE_SEED: 'seed-a' } });
    expect(tagValue(seeded.text, TAG.transcript)).toBe(fakeSessionId('seed-a'));
  });

  it('TC-FAKE-08 a resumed session appends to the file under fresh record ids', async () => {
    const root = tempDir('fake-resume').path;
    const project = join(root, 'FIXTURE project');
    const first = await runFake(`/transcript 1 ${project}\n`, { root });
    const id = fakeSessionId();
    const file = join(first.claudeHome, 'projects', projectDirName(project), `${id}.jsonl`);
    const before = readJsonLines(file);
    await runFake(`/transcript 1 ${project}\n`, { root, args: ['--resume', id] });
    const after = readJsonLines(file);
    expect(after).toHaveLength(before.length + 2);
    expect(new Set(after.map((record) => record['uuid'])).size).toBe(after.length);
  });

  it('TC-FAKE-08 removes the registry file on a normal exit, keeps it when asked and when the process is killed', async () => {
    const gone = await runFake('/exit\n', { env: { FAKE_CLAUDE_AUTOREGISTER: '1' } });
    const gonePid = parseReady(gone.text)?.pid ?? 0;
    expect(existsSync(join(gone.claudeHome, 'sessions', `${String(gonePid)}.json`))).toBe(false);
    expect(existsSync(join(gone.claudeHome, 'sessions'))).toBe(true);
    const crashed = await runFake('/crash\n', { env: { FAKE_CLAUDE_AUTOREGISTER: '1' } });
    expect(existsSync(join(crashed.claudeHome, 'sessions', `${String(parseReady(crashed.text)?.pid ?? 0)}.json`))).toBe(
      false,
    );
    const kept = await runFake('/exit\n', { env: { FAKE_CLAUDE_AUTOREGISTER: '1', FAKE_CLAUDE_KEEP_REGISTRY: '1' } });
    const keptEntry = readJsonFile(
      join(kept.claudeHome, 'sessions', `${String(parseReady(kept.text)?.pid ?? 0)}.json`),
    );
    expect(keptEntry['status']).toBe('idle');
    expect(keptEntry['sessionId']).toBe(fakeSessionId());
    expect(existsSync(join(kept.claudeHome, 'projects'))).toBe(false);
    const fake = startFake({ env: { FAKE_CLAUDE_AUTOREGISTER: '1' } });
    const file = join(fake.claudeHome, 'sessions', `${String(fake.child.pid)}.json`);
    await waitFor(() => existsSync(file), { what: 'the registry file of a running fake' });
    fake.child.kill('SIGKILL');
    await fake.exited;
    expect(existsSync(file)).toBe(true);
  });

  it('TC-FAKE-08 writes nothing when there is no absolute Claude folder', async () => {
    const root = tempDir('fake-nohome').path;
    for (const value of ['', 'relative-home']) {
      const run = await runFake('/transcript 1\n/status busy\n', {
        root,
        env: { CLAUDE_CONFIG_DIR: value, FAKE_CLAUDE_AUTOREGISTER: '1' },
      });
      expect(afterBanner(run.text)).toEqual([`${TAG.error}no-config-dir`, `${TAG.error}no-config-dir`]);
      expect(existsSync(join(root, 'home', '.claude'))).toBe(false);
      expect(existsSync(join(root, 'relative-home'))).toBe(false);
      expect(existsSync(join(root, 'sessions'))).toBe(false);
    }
  });

  it('TC-FAKE-09 /ignore-signals installs handlers that log SIGNAL and keep the process alive', async () => {
    const fake = startFake();
    fake.send('/ignore-signals\n');
    await waitFor(() => fake.text().includes(TAG.ignoring), { what: 'the IGNORING answer' });
    if (process.platform !== 'win32') {
      // Windows ends a process on every signal that Node can send, so only the other platforms deliver one.
      fake.child.kill('SIGTERM');
      await waitFor(() => fake.text().includes(`${TAG.signal}SIGTERM`), { what: 'the SIGNAL answer' });
      expect(fake.child.exitCode).toBeNull();
      expect(
        parseFakeLog(readFileSync(fake.logPath, 'utf8')).some(
          (entry) => entry.ev === 'signal' && entry['name'] === 'SIGTERM',
        ),
      ).toBe(true);
    }
    fake.send('/exit 0\n');
    expect((await fake.exited).code).toBe(0);
    const log = parseFakeLog(readFileSync(fake.logPath, 'utf8'));
    expect(log.some((entry) => entry.ev === 'cmd' && entry['name'] === '/ignore-signals')).toBe(true);
  });

  it('TC-FAKE-09 /spawn-child and /spawn start sleeping children and report their pids', async () => {
    const fake = startFake();
    fake.send('/spawn-child\n/spawn\n');
    const pids = await waitFor(
      () => {
        const found = [...fake.text().matchAll(/^CHILD:(\d+)\r?$/gm)].map((match) => Number(match[1]));
        return found.length === 2 ? found : null;
      },
      { what: 'two CHILD answers' },
    );
    try {
      expect(pids[0]).not.toBe(pids[1]);
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      fake.send('/exit-now\n');
      await fake.exited;
      // The fake neither waits for its children nor ends them. After it is gone a child lives on, except on Windows, where libuv
      // puts a child that is not detached into a job that ends with its parent.
      if (process.platform !== 'win32') for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
    }
  });

  it('TC-FAKE-10 /hostile writes the hostile sequences, a one MiB line and invalid bytes, then HOSTILE-DONE', async () => {
    const run = await runFake('/hostile\n');
    expect(run.code).toBe(0);
    const bytes = run.bytes;
    const has = (value: string | Buffer): boolean => bytes.includes(value);
    expect(has(`${ESC}]52;c;`)).toBe(true);
    expect(has(`${ESC}]0;`)).toBe(true);
    expect(has(`${ESC}]8;;javascript:`)).toBe(true);
    expect(has(`${ESC}]8;;http://`)).toBe(true);
    expect(has(`${ESC}[21t`)).toBe(true);
    expect(has(`${ESC}[6n`)).toBe(true);
    expect(bytes.filter((byte) => byte === 7).length).toBeGreaterThanOrEqual(100);
    expect(has(Buffer.from([0xff, 0xfe]))).toBe(true);
    expect(has(Buffer.alloc(HOSTILE_LONG_LINE_BYTES, 'x'))).toBe(true);
    // Between two line ends the long line has no line end of its own.
    const longRun = bytes.indexOf(Buffer.alloc(1024, 'x'));
    expect(longRun).toBeGreaterThan(0);
    expect(bytes.subarray(longRun, longRun + HOSTILE_LONG_LINE_BYTES).includes(10)).toBe(false);
    expect(run.text.endsWith(`${TAG.hostileDone}\r\n${FAKE_PROMPT}`)).toBe(true);
    const clipboard = /\]52;c;([A-Za-z0-9+/=]+)/.exec(bytes.toString('latin1'))?.[1];
    expect(Buffer.from(clipboard ?? '', 'base64').toString('utf8')).toMatch(/^FIXTURE/);
  }, 20_000);

  it('TC-FAKE-10 /query writes its tag and both query sequences, once each, in this order', async () => {
    const run = await runFake('/query\n/query extra words\n');
    expect(run.code).toBe(0);
    const sequences = `${ESC}[c${ESC}[6n`;
    const answer = `${TAG.query}${sequences}\r\n`;
    expect(run.text.split(answer)).toHaveLength(3);
    expect(run.text.endsWith(`${answer}${FAKE_PROMPT}`)).toBe(true);
    // Besides the banner (which sets bracketed paste) nothing else in the output asks the terminal a question.
    expect(run.text.split(`${ESC}[c`)).toHaveLength(3);
    expect(run.text.split(`${ESC}[6n`)).toHaveLength(3);
    // The query is not an echo: the tag stays at the beginning of a line and the line holds nothing else.
    expect(afterBanner(run.text)).toEqual(['QUERY:', 'QUERY:']);
    expect(
      run.log.filter((entry) => entry.ev === 'cmd').map((entry) => `${String(entry['name'])}:${String(entry['args'])}`),
    ).toEqual(['/query:0', '/query:2']);
  });

  it('TC-FAKE-11 FAKE_CLAUDE_STARTUP=exit:N exits at once without output', async () => {
    const run = await runFake('', { env: { FAKE_CLAUDE_STARTUP: 'exit:3' } });
    expect(run.code).toBe(3);
    expect(run.text).toBe('');
    expect(run.log.map((entry) => entry.ev)).toEqual(['start', 'exit']);
    expect(run.log[1]?.['code']).toBe(3);
    const zero = await runFake('', { env: { FAKE_CLAUDE_STARTUP: 'exit:0' } });
    expect(zero.code).toBe(0);
    expect(zero.text).toBe('');
  });

  it('TC-FAKE-11 FAKE_CLAUDE_STARTUP=hang prints nothing and never exits on its own', async () => {
    const fake = startFake({ env: { FAKE_CLAUDE_STARTUP: 'hang' } });
    await waitFor(() => existsSync(fake.logPath) && readFileSync(fake.logPath, 'utf8').includes('"start"'), {
      what: 'the start entry of a hanging fake',
    });
    fake.send('/exit 0\nhello\n');
    fake.end();
    await waitFor(() => fake.child.stdin.writableFinished, { what: 'stdin of the hanging fake to be written' });
    expect(fake.child.exitCode).toBeNull();
    expect(fake.text()).toBe('');
    fake.child.kill('SIGKILL');
    const { code, signal } = await fake.exited;
    expect(code ?? signal).not.toBe(0);
    expect(fake.text()).toBe('');
  });

  it('TC-FAKE-11 an unknown FAKE_CLAUDE_STARTUP value starts normally', async () => {
    const run = await runFake('/exit 0\n', { env: { FAKE_CLAUDE_STARTUP: 'bogus' } });
    expect(run.code).toBe(0);
    expect(parseReady(run.text)).not.toBeNull();
  });

  it('TC-FAKE-12 two runs of one scenario write the same log, which has no timestamps and no secret text', async () => {
    const scenario = `hello\n/size\n/args\n/env TERM FIXTURE_X\n/envscan ${CANARY.envToken}\n\x03/exit 2\n`;
    const a = await runFake(scenario, { args: ['--flag'], env: { FIXTURE_X: '1' } });
    const b = await runFake(scenario, { args: ['--flag'], env: { FIXTURE_X: '1' } });
    expect(a.code).toBe(2);
    const first = coalesceStdin(a.log);
    expect(first).toEqual(coalesceStdin(b.log));
    expect(first.map((entry) => entry.n)).toEqual(first.map((_, index) => index + 1));
    expect(first[0]?.ev).toBe('start');
    expect(first[0]?.['argv']).toEqual(['--flag']);
    const names = first[0]?.['env'];
    expect(names).toEqual([...(names as string[])].sort());
    expect(names).toContain('FAKE_CLAUDE_LOG');
    expect(names).toContain('FIXTURE_X');
    expect(first.at(-1)).toMatchObject({ ev: 'exit', code: 2 });
    const stdinHex = a.log
      .filter((entry) => entry.ev === 'stdin')
      .map((entry) => String(entry['hex']))
      .join('');
    expect(stdinHex).toBe(Buffer.from(scenario).toString('hex'));
    const commands = first
      .filter((entry) => entry.ev === 'cmd')
      .map((entry) => `${String(entry['name'])}:${String(entry['args'])}`);
    expect(commands).toEqual(['text:1', '/size:0', '/args:0', '/env:2', '/envscan:1', '/exit:1']);
    for (const entry of a.log) {
      for (const key of Object.keys(entry))
        expect(['n', 'ev', 'argv', 'env', 'hex', 'cols', 'rows', 'name', 'args', 'code']).toContain(key);
    }
    expect(a.logText).not.toContain(CANARY.envToken);
  });

  it('TC-FAKE-12 a killed process wrote no exit entry', async () => {
    const fake = startFake();
    fake.send('hello\n');
    await waitFor(() => fake.text().includes('ECHO:hello'), { what: 'the echo of a running fake' });
    fake.child.kill('SIGKILL');
    await fake.exited;
    const log = parseFakeLog(readFileSync(fake.logPath, 'utf8'));
    expect(log.some((entry) => entry.ev === 'exit')).toBe(false);
    expect(log[0]?.ev).toBe('start');
  });

  it('TC-FAKE-13 a bracketed paste is one answer, its newlines do not end the line', async () => {
    const text = 'line1\nline2 é';
    const run = await runFake(`${ESC}[200~${text}${ESC}[201~\n`);
    const expectedHash = createHash('sha256').update(text).digest('hex').slice(0, 8);
    expect(afterBanner(run.text)).toEqual([`${TAG.paste}13:${expectedHash}`]);
    expect(run.log.filter((entry) => entry.ev === 'cmd').map((entry) => entry['name'])).toEqual(['paste']);
  });

  it('TC-FAKE-13 a paste split across chunks, and keys with escape sequences around it, are read whole', async () => {
    const fake = startFake();
    fake.send(`${ESC}[20`);
    fake.send(`0~ab`);
    fake.send(`c${ESC}[`);
    fake.send('201~');
    fake.send(`${ESC}[A${ESC}OPtyped\n`);
    await waitFor(() => fake.text().includes('ECHO:typed'), { what: 'the answers of the split paste' });
    const hash = createHash('sha256').update('abc').digest('hex').slice(0, 8);
    expect(afterBanner(fake.text())).toEqual([`${TAG.paste}3:${hash}`, 'ECHO:typed']);
    fake.end();
    expect((await fake.exited).code).toBe(0);
  });

  it('TC-FAKE-13 a multi-byte character split across two chunks is decoded whole', async () => {
    const fake = startFake();
    const bytes = Buffer.from('/echo é漢');
    fake.send(bytes.subarray(0, 7));
    fake.send(bytes.subarray(7, 9));
    fake.send(Buffer.concat([bytes.subarray(9), Buffer.from('\n')]));
    await waitFor(() => fake.text().includes('é漢'), { what: 'the echo of the split character' });
    expect(afterBanner(fake.text())).toEqual(['é漢']);
    fake.end();
    await fake.exited;
  });
});
