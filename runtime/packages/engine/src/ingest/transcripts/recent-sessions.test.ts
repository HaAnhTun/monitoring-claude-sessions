// The newest sessions of a transcripts folder for `discover`: order, limit, the whole first prompt (the caller clips it),
// boilerplate skipped, and no prompt in any log. Synthetic transcripts in a temp folder.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nodeDiscoveryFs, type DiscoveryFs } from './discovery.ts';
import { recentSessionsOf, type RecentSessionsLog } from './recent-sessions.ts';

const makeTemp = useTempDirs();
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const NL = String.fromCharCode(10);
const SECRET_PROMPT = 'FIXTURE prompt that must never reach a log';

function user(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function session(dir: string, id: string, records: readonly unknown[], ageMs: number): void {
  const file = path.join(dir, `${id}.jsonl`);
  writeFileSync(file, records.map((r) => JSON.stringify(r) + NL).join(''));
  const at = new Date(NOW - ageMs);
  utimesSync(file, at, at);
}

function folder(): string {
  const dir = path.join(makeTemp('recent').path, 'projects', 'D--work-repo');
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recentSessionsOf', () => {
  it('lists the main transcripts newest first, up to the limit, with age and size', async () => {
    const dir = folder();
    session(dir, S1, [user('FIXTURE one')], 30_000);
    session(dir, S2, [user('FIXTURE two')], 10_000);
    session(dir, S3, [user('FIXTURE three')], 20_000);
    writeFileSync(path.join(dir, 'not-a-session.jsonl'), '');
    mkdirSync(path.join(dir, S1));

    const all = await recentSessionsOf(dir, 15, NOW);
    expect(all.map((s) => s.id)).toEqual([S2, S3, S1]);
    expect(all[0]?.ageSeconds).toBeCloseTo(10, 0);
    expect(all[0]?.bytes).toBeGreaterThan(0);
    expect(all.map((s) => s.firstPrompt)).toEqual(['FIXTURE two', 'FIXTURE three', 'FIXTURE one']);

    expect((await recentSessionsOf(dir, 2, NOW)).map((s) => s.id)).toEqual([S2, S3]);
    expect(await recentSessionsOf(dir, 0, NOW)).toEqual([]);
  });

  it('returns the first real prompt whole, after the harness boilerplate', async () => {
    const dir = folder();
    const long = 'FIXTURE '.repeat(100).trim();
    session(dir, S1, [{ type: 'system' }, user('<system-reminder>FIXTURE boiler</system-reminder>'), user(long)], 0);
    const [only] = await recentSessionsOf(dir, 15, NOW);
    expect(only?.firstPrompt).toBe(long);
  });

  it('answers an empty list for a folder it cannot list and an empty prompt for a file it cannot read', async () => {
    expect(await recentSessionsOf(path.join(folder(), 'missing'), 15, NOW)).toEqual([]);
    const dir = folder();
    session(dir, S1, [user(SECRET_PROMPT)], 0);
    const unreadable: DiscoveryFs = { ...nodeDiscoveryFs, readHead: () => Promise.resolve(null) };
    const [only] = await recentSessionsOf(dir, 15, NOW, unreadable);
    expect(only?.firstPrompt).toBe('');
  });

  it('never logs a prompt', async () => {
    const dir = folder();
    session(dir, S1, [user(SECRET_PROMPT)], 0);
    session(dir, S2, [user(SECRET_PROMPT)], 1000);
    const debug = vi.fn<RecentSessionsLog['debug']>();
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const flaky: DiscoveryFs = {
      ...nodeDiscoveryFs,
      readHead: (file, max) => (file.includes(S2) ? Promise.resolve(null) : nodeDiscoveryFs.readHead(file, max)),
    };
    const listed = await recentSessionsOf(dir, 15, NOW, flaky, { debug });
    expect(listed[0]?.firstPrompt).toBe(SECRET_PROMPT);
    expect(debug).toHaveBeenCalled();
    const logged = JSON.stringify([debug.mock.calls, stdout.mock.calls, stderr.mock.calls]);
    expect(logged).not.toContain(SECRET_PROMPT);
    expect(logged).not.toContain(dir);
  });
});
