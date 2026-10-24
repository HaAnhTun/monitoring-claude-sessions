// The dispatch of `tools/call` and the `tools/list` descriptors (server.ts) over a fake runtime: unknown and write-like names are not
// tools, a bad argument is an `isError` result with a fixed message that does not repeat the value, a failure never leaks its message,
// every result carries the data notice, and the number of calls that run at once is bounded.
import { McsError } from '@mcs/shared';
import { describe, expect, it, vi } from 'vitest';

import { DATA_NOTICE } from './render.ts';
import { MAX_CONCURRENT_CALLS, SERVER_INSTRUCTIONS, callHandler } from './server.ts';
import type { McpReader, ToolRuntime } from './tools.ts';

function runtimeOf(reader: Partial<Record<string, () => Promise<unknown>>> = {}): ToolRuntime {
  return {
    withReader: (run) => run({ mode: 'db', instanceId: 'i', ...reader } as unknown as McpReader),
    showSession: () => Promise.reject(new Error('not used')),
    status: () => Promise.resolve({ running: false, probe: 'stopped' }),
    nowMs: () => 0,
  };
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof callHandler>>>): Record<string, unknown> {
  expect(result).not.toBeNull();
  return JSON.parse(result?.content[0]?.text ?? 'null') as Record<string, unknown>;
}

describe('server instructions', () => {
  it('carry the data notice and say that nothing is changed', () => {
    expect(SERVER_INSTRUCTIONS).toContain(DATA_NOTICE);
    expect(SERVER_INSTRUCTIONS).toMatch(/Read-only/);
  });
});

describe('callHandler', () => {
  it('answers null for a name that is not a tool, including write-like and transcript names without --include-text', async () => {
    const call = callHandler({ version: '1', includeText: false, runtime: runtimeOf() });
    for (const name of [
      'mcs_stop',
      'mcs_start',
      'mcs_restart',
      'mcs_delete_session',
      'mcs_export',
      'nope',
      '',
      'mcs_read_transcript',
      'mcs_search_transcripts',
    ]) {
      expect(await call(name, {}), name).toBeNull();
    }
    expect(await call('mcs_instance_status', {})).not.toBeNull();
    const withText = callHandler({ version: '1', includeText: true, runtime: runtimeOf() });
    expect(await withText('mcs_read_transcript', {})).not.toBeNull();
  });

  it('runs a tool and renders its data in the envelope with the notice', async () => {
    const call = callHandler({ version: '1', includeText: false, runtime: runtimeOf() });
    const result = await call('mcs_instance_status', undefined);
    expect(result?.isError).toBeUndefined();
    expect(textOf(result)).toMatchObject({
      kind: 'mcs.mcp/1',
      readOnly: true,
      dataNotice: DATA_NOTICE,
      truncated: false,
    });
  });

  it('answers a bad argument with an isError result whose message is fixed and does not repeat the value', async () => {
    const call = callHandler({ version: '1', includeText: false, runtime: runtimeOf() });
    const secret = 'SECRET-VALUE-9f3a';
    for (const args of [{ limit: secret }, { [secret]: 1 }, { state: 5 }, secret, ['x', secret]]) {
      const result = await call('mcs_list_sessions', args);
      expect(result?.isError, JSON.stringify(args)).toBe(true);
      const text = result?.content[0]?.text ?? '';
      expect(text).not.toContain(secret);
      const envelope = textOf(result) as {
        data: unknown;
        dataNotice: string;
        error: { code: string; message: string };
      };
      expect(envelope.data).toBeNull();
      expect(envelope.dataNotice).toBe(DATA_NOTICE);
      expect(envelope.error.code).toBe('invalid_arguments');
    }
    const first = await call('mcs_list_sessions', { limit: 'aaa' });
    const second = await call('mcs_list_sessions', { limit: 'bbbbbb' });
    expect(first?.content[0]?.text).toBe(second?.content[0]?.text);
  });

  it('turns an expected failure into a catalogue code and an unexpected one into INTERNAL, without their messages', async () => {
    const failures: unknown[] = [];
    const call = callHandler({
      version: '1',
      includeText: false,
      onToolFailure: (_tool, error) => failures.push(error),
      runtime: runtimeOf({
        overview: () => Promise.reject(new McsError('DB_ERROR', 'cannot open C:/Users/someone/monitor.db')),
        sessions: () => Promise.reject(new Error('boom at /home/someone/x.ts:12')),
      }),
    });
    const db = await call('mcs_overview', {});
    expect(db?.isError).toBe(true);
    expect((textOf(db) as { error: { code: string } }).error.code).toBe('DB_ERROR');
    expect(db?.content[0]?.text).not.toContain('someone');
    const internal = await call('mcs_list_sessions', {});
    expect((textOf(internal) as { error: { code: string } }).error.code).toBe('INTERNAL');
    expect(internal?.content[0]?.text).not.toContain('someone');
    expect(failures).toHaveLength(2);
  });

  it('does not report a refused argument as a failure of the tool', async () => {
    const onToolFailure = vi.fn();
    const call = callHandler({ version: '1', includeText: false, runtime: runtimeOf(), onToolFailure });
    await call('mcs_list_sessions', { limit: 0 });
    expect(onToolFailure).not.toHaveBeenCalled();
  });

  it('runs at most four calls at once and finishes them all', async () => {
    let running = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const call = callHandler({
      version: '1',
      includeText: false,
      runtime: runtimeOf({
        errors: () => {
          running += 1;
          peak = Math.max(peak, running);
          return new Promise((resolve) => {
            releases.push(() => {
              running -= 1;
              resolve([]);
            });
          });
        },
      }),
    });
    const all = Array.from({ length: 10 }, () => call('mcs_errors', {}));
    await vi.waitFor(() => {
      expect(releases.length).toBe(MAX_CONCURRENT_CALLS);
    });
    expect(peak).toBe(MAX_CONCURRENT_CALLS);
    while (releases.length > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    // drain what started after the first batch finished
    for (let round = 0; round < 10 && releases.length + running > 0; round += 1) {
      while (releases.length > 0) releases.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = await Promise.all(all);
    expect(results.every((r) => r?.isError === undefined)).toBe(true);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_CALLS);
  });
});
