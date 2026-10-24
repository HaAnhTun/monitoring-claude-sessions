import { FakeClock, FIXTURE_EPOCH_MS } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { ChildResult, ChildSpec } from '../platform/exec.ts';
import { createErrorRing } from '../runtime/error-ring.ts';
import { createDockerSource, parseDockerLines } from './docker.ts';

const DOCKER = '/usr/bin/docker';

const result = (over: Partial<ChildResult>): ChildResult => ({
  ok: over.error === undefined && (over.code ?? 0) === 0,
  code: 0,
  stdout: '',
  stderr: '',
  error: null,
  truncated: false,
  durationMs: 1,
  ...over,
});

function setup(answer: Partial<ChildResult>, over: { enabled?: boolean; file?: string | null } = {}) {
  const clock = new FakeClock(FIXTURE_EPOCH_MS);
  const calls: ChildSpec[] = [];
  let resolves = 0;
  const source = createDockerSource({
    enabled: over.enabled ?? true,
    clock,
    errors: createErrorRing(clock),
    exec: {
      resolveExecutable: () => {
        resolves += 1;
        return Promise.resolve(over.file === undefined ? DOCKER : over.file);
      },
      execFileText: (spec) => {
        calls.push(spec);
        return Promise.resolve(result(answer));
      },
    },
  });
  return { source, clock, calls, resolves: () => resolves };
}

describe('parseDockerLines', () => {
  it('trims lines and drops empty ones', () => {
    expect(parseDockerLines('web (Up 2 hours)\r\n\r\n  db (Up 5 minutes) \n   \n')).toEqual([
      'web (Up 2 hours)',
      'db (Up 5 minutes)',
    ]);
  });

  it('keeps at most 50 lines in the order docker printed them', () => {
    const lines = Array.from({ length: 80 }, (_, i) => `c${String(i)} (Up)`);
    const parsed = parseDockerLines(lines.join('\n'));
    expect(parsed).toHaveLength(50);
    expect(parsed[0]).toBe('c0 (Up)');
    expect(parsed[49]).toBe('c49 (Up)');
  });
});

describe('createDockerSource', () => {
  it('runs docker ps with a constant format and serves the lines', async () => {
    const { source, calls } = setup({ stdout: 'web (Up 2 hours)\ndb (Up 5 minutes)\n' });
    const read = await source.read();
    expect(read).toMatchObject({ status: 'ok', value: ['web (Up 2 hours)', 'db (Up 5 minutes)'], message: null });
    expect(read.sampledAt).toBe(FIXTURE_EPOCH_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'docker',
      file: DOCKER,
      args: ['ps', '--format', '{{.Names}} ({{.Status}})'],
      timeoutMs: 8000,
      maxOutputBytes: 262_144,
      encoding: 'utf8',
    });
  });

  it('caps the lines of an exit 0 answer at 50', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `c${String(i)} (Up)`).join('\n');
    const read = await setup({ stdout: lines }).source.read();
    expect(read.value).toHaveLength(50);
  });

  it('is an error with the first stderr line when docker exits non-zero', async () => {
    const { source } = setup({
      ok: false,
      code: 1,
      error: 'NONZERO_EXIT',
      stderr: '\nCannot connect to the Docker daemon. Is it running?\nmore detail\n',
    });
    const read = await source.read();
    expect(read.status).toBe('error');
    expect(read.message).toBe('Cannot connect to the Docker daemon. Is it running?');
    expect(read.value).toBeNull();
  });

  it('clips a long stderr line to 200 characters', async () => {
    const read = await setup({ ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'x'.repeat(500) }).source.read();
    expect(read.message).toHaveLength(200);
  });

  it('is unavailable when docker is not on PATH, and asks again only after 5 minutes', async () => {
    const { source, clock, resolves } = setup({}, { file: null });
    const first = await source.read();
    expect(first).toMatchObject({ status: 'unavailable', message: 'docker not found on PATH' });
    expect(resolves()).toBe(1);
    clock.advance(4 * 60_000);
    await source.read();
    expect(resolves()).toBe(1);
    clock.advance(61_000);
    await source.read();
    expect(resolves()).toBe(2);
  });

  it('is unavailable on ENOENT of the spawn and caches that for 5 minutes', async () => {
    const { source, clock, calls } = setup({ ok: false, code: null, error: 'ENOENT' });
    expect((await source.read()).status).toBe('unavailable');
    clock.advance(20_000);
    expect((await source.read()).status).toBe('unavailable');
    expect(calls).toHaveLength(1);
    clock.advance(5 * 60_000);
    await source.read();
    expect(calls).toHaveLength(2);
  });

  it('maps a timeout and an oversized answer to errors', async () => {
    const timeout = await setup({ ok: false, code: null, error: 'TIMEOUT' }).source.read();
    expect(timeout).toMatchObject({ status: 'error', message: 'docker ps timed out' });
    const big = await setup({ ok: false, code: null, error: 'OUTPUT_LIMIT', truncated: true }).source.read();
    expect(big).toMatchObject({ status: 'error', message: 'docker ps output is too large' });
  });

  it('serves the last list while a refresh fails', async () => {
    const clock = new FakeClock(FIXTURE_EPOCH_MS);
    const answers = [
      result({ stdout: 'a (Up)\n' }),
      result({ ok: false, code: 1, error: 'NONZERO_EXIT', stderr: 'daemon down' }),
    ];
    let n = 0;
    const source = createDockerSource({
      enabled: true,
      clock,
      errors: createErrorRing(clock),
      exec: {
        resolveExecutable: () => Promise.resolve(DOCKER),
        execFileText: () => Promise.resolve(answers[Math.min(n++, 1)] ?? result({})),
      },
    });
    await source.read();
    clock.advance(16_000);
    await source.read(); // starts the failing refresh, serves the old value
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    const again = await source.read();
    expect(again.value).toEqual(['a (Up)']);
    expect(again.status).toBe('error');
    expect(again.message).toBe('daemon down');
  });

  it('makes no call at all when disabled', async () => {
    const { source, calls, resolves } = setup({ stdout: 'a (Up)\n' }, { enabled: false });
    const read = await source.read();
    expect(read).toEqual({ value: null, sampledAt: null, status: 'disabled', message: null });
    expect(source.enabled).toBe(false);
    expect(calls).toHaveLength(0);
    expect(resolves()).toBe(0);
    expect(source.stats()).toBeNull();
  });
});
