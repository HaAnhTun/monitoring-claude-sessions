// The daemon job reader (02 7.10): one level of `jobs/`, only `<id>/state.json`, matched by `sessionId` or `resumeSessionId`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { JOB_FIXTURE_TIME, jobState, writeJob } from '../../test/fixtures/external.ts';
import { JOB_FAILED_STATES } from '../lifecycle/derive-session.ts';
import { nodeExternalFs, type ExternalFs } from './fs.ts';
import { JOB_TERMINAL_STATES, createJobsReader, jobEventTime } from './jobs.ts';

const tempDir = useTempDirs();
const KNOWN = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const START = Date.UTC(2026, 9, 12, 8, 0, 0);
const DAY = 86_400_000;
const SIX_DAYS_AGO = START - 6 * DAY;

function jobsReader(
  claudeHome: string,
  fs?: ExternalFs,
): { reader: ReturnType<typeof createJobsReader>; clock: FakeClock } {
  const clock = new FakeClock(START);
  return {
    clock,
    reader: createJobsReader({
      claudeHome,
      now: () => clock.now(),
      isKnownSession: (uid) => uid === KNOWN,
      ...(fs === undefined ? {} : { fs }),
    }),
  };
}

describe('createJobsReader', () => {
  it('reads only <id>/state.json and never walks the temp files of a job', async () => {
    const home = tempDir('jobs').path;
    writeJob(home, 'job-1', jobState({ state: 'working', sessionId: KNOWN }));
    writeJob(home, 'job-2', jobState({ state: 'done', sessionId: OTHER }));
    const opened: string[] = [];
    const listed: string[] = [];
    const spy: ExternalFs = {
      readdir: (dir) => {
        listed.push(path.basename(dir));
        return nodeExternalFs.readdir(dir);
      },
      readSmall: (file, max) => {
        opened.push(path.relative(home, file).replaceAll('\\', '/'));
        return nodeExternalFs.readSmall(file, max);
      },
    };
    const { reader } = jobsReader(home, spy);
    const poll = await reader.poll();
    // the time the job file recorded (its updatedAt), not the clock of the reader (ADR 0069)
    expect(poll.events).toEqual([
      { k: 'external.job', sessionId: KNOWN, jobId: 'job-1', state: 'working', observedAt: JOB_FIXTURE_TIME },
    ]);
    expect(listed).toEqual(['jobs']);
    expect(opened).toEqual(['jobs/job-1/state.json', 'jobs/job-2/state.json']);
  });

  it('matches a job through resumeSessionId when sessionId is unknown', async () => {
    const home = tempDir('jobs').path;
    writeJob(home, 'job-1', jobState({ state: 'done', sessionId: OTHER, resumeSessionId: KNOWN }));
    const { reader } = jobsReader(home);
    expect((await reader.poll()).events.map((e) => e.sessionId)).toEqual([KNOWN]);
  });

  it('produces an event only when the state of a job changes', async () => {
    const home = tempDir('jobs').path;
    const dir = writeJob(home, 'job-1', jobState({ state: 'working', sessionId: KNOWN }));
    const { reader } = jobsReader(home);
    const first = await reader.poll();
    expect(first.events).toHaveLength(1);
    first.commit();
    expect((await reader.poll()).events).toEqual([]);
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(jobState({ state: 'done', sessionId: KNOWN })));
    const changed = await reader.poll();
    expect(changed.events.map((e) => e.state)).toEqual(['done']);
  });

  it('comes again after a poll that was not committed', async () => {
    const home = tempDir('jobs').path;
    writeJob(home, 'job-1', jobState({ state: 'working', sessionId: KNOWN }));
    const { reader } = jobsReader(home);
    expect((await reader.poll()).events).toHaveLength(1);
    expect((await reader.poll()).events).toHaveLength(1);
  });

  it('skips a folder without state.json and counts a damaged state file', async () => {
    const home = tempDir('jobs').path;
    const dir = writeJob(home, 'job-1', jobState({ state: 'working', sessionId: KNOWN }));
    writeFileSync(path.join(dir, 'state.json'), '{"state": FIXTURE damaged');
    writeJob(home, 'job-2', jobState({ state: 'working', sessionId: KNOWN }));
    rmSync(path.join(home, 'jobs', 'job-2', 'state.json'));
    const { reader } = jobsReader(home);
    const poll = await reader.poll();
    expect(poll.events).toEqual([]);
    expect(poll.readFailures).toBe(1);
  });

  it('ignores a job folder whose name is not a plain id', async () => {
    const home = tempDir('jobs').path;
    writeJob(home, 'job-1', jobState({ state: 'working', sessionId: KNOWN }));
    mkdirSync(path.join(home, 'jobs', '.hidden'), { recursive: true });
    writeFileSync(
      path.join(home, 'jobs', '.hidden', 'state.json'),
      JSON.stringify(jobState({ state: 'done', sessionId: KNOWN })),
    );
    const { reader } = jobsReader(home);
    expect((await reader.poll()).events.map((e) => e.jobId)).toEqual(['job-1']);
  });

  it('answers an empty poll for a Claude home without jobs', async () => {
    const { reader } = jobsReader(tempDir('jobs').path);
    expect(await reader.poll()).toMatchObject({ events: [], readFailures: 0 });
  });
});

describe('the time of a job event (ADR 0069)', () => {
  const iso = (ms: number): string => new Date(ms).toISOString();

  it('stamps a done job with lastTerminalAt, six days before the clock, not with the clock', async () => {
    const home = tempDir('jobs').path;
    writeJob(
      home,
      'job-1',
      jobState({
        state: 'done',
        sessionId: KNOWN,
        createdAt: SIX_DAYS_AGO - 3_600_000,
        updatedAt: SIX_DAYS_AGO - 60_000,
        terminalAt: SIX_DAYS_AGO,
      }),
    );
    const { reader, clock } = jobsReader(home);
    const [event] = (await reader.poll()).events;
    expect(event?.observedAt).toBe(SIX_DAYS_AGO);
    expect(clock.now() - (event?.observedAt ?? 0)).toBe(6 * DAY);
  });

  it('stamps a working job with updatedAt even when an older lastTerminalAt is present', () => {
    const file = { state: 'working', lastTerminalAt: iso(SIX_DAYS_AGO), updatedAt: iso(START - 1000) };
    expect(jobEventTime(file, 'working', START, null)).toBe(START - 1000);
  });

  it('falls back from lastTerminalAt to firstTerminalAt, updatedAt, createdAt, then the file time', () => {
    const createdOnly = { createdAt: iso(START - 4) };
    const noTerminal = { ...createdOnly, updatedAt: iso(START - 3) };
    const noLast = { ...noTerminal, firstTerminalAt: iso(START - 2) };
    const all = { ...noLast, lastTerminalAt: iso(START - 1) };
    expect(jobEventTime(all, 'done', START, START - 5)).toBe(START - 1);
    expect(jobEventTime(noLast, 'done', START, START - 5)).toBe(START - 2);
    expect(jobEventTime(noTerminal, 'failed', START, START - 5)).toBe(START - 3);
    expect(jobEventTime(createdOnly, 'done', START, START - 5)).toBe(START - 4);
    expect(jobEventTime({}, 'done', START, START - 5)).toBe(START - 5);
    expect(jobEventTime({}, 'working', START, null)).toBeNull();
  });

  it('takes the modification time from the fs seam when the file has no usable time', async () => {
    const home = tempDir('jobs').path;
    writeJob(home, 'job-1', { state: 'done', sessionId: KNOWN });
    const asked: string[] = [];
    const spy: ExternalFs = {
      ...nodeExternalFs,
      mtimeMs: (file) => {
        asked.push(path.basename(file));
        return Promise.resolve(SIX_DAYS_AGO);
      },
    };
    const { reader } = jobsReader(home, spy);
    const poll = await reader.poll();
    expect(poll.events.map((e) => e.observedAt)).toEqual([SIX_DAYS_AGO]);
    expect(asked).toEqual(['state.json']);
  });

  it('accepts epoch milliseconds', () => {
    const file = jobState({ state: 'done', sessionId: KNOWN, terminalAt: SIX_DAYS_AGO, epochMs: true });
    expect(jobEventTime(file, 'done', START, null)).toBe(SIX_DAYS_AGO);
  });

  it('clamps a time after the clock to the clock', () => {
    expect(jobEventTime({ lastTerminalAt: iso(START + DAY) }, 'done', START, null)).toBe(START);
    expect(jobEventTime({ updatedAt: '9999-12-31T00:00:00.000Z' }, 'working', START, null)).toBe(START);
    expect(jobEventTime({}, 'working', START, START + DAY)).toBe(START);
  });

  it.each([
    ['empty text', ''],
    ['negative number', -5],
    ['NaN text', 'NaN'],
    ['zero text', '0'],
    ['a date without a zone', '2026-10-06T08:00:00'],
    ['object', { at: SIX_DAYS_AGO }],
    ['array', [SIX_DAYS_AGO]],
  ])('skips a junk value (%s) and uses the next field', (_name, junk) => {
    const file = { lastTerminalAt: junk, firstTerminalAt: iso(SIX_DAYS_AGO) };
    expect(jobEventTime(file, 'done', START, null)).toBe(SIX_DAYS_AGO);
  });

  it('counts a job without any usable time and without a file time as unreadable, with no event', async () => {
    const home = tempDir('jobs').path;
    writeJob(home, 'job-1', { state: 'done', sessionId: KNOWN, updatedAt: 'FIXTURE junk' });
    const { reader } = jobsReader(home, { ...nodeExternalFs, mtimeMs: () => Promise.resolve(null) });
    const poll = await reader.poll();
    expect(poll.events).toEqual([]);
    expect(poll.readFailures).toBe(1);
  });

  it('announces the same state again when its time changed, and stays silent on an unchanged poll', async () => {
    const home = tempDir('jobs').path;
    const dir = writeJob(home, 'job-1', jobState({ state: 'done', sessionId: KNOWN, terminalAt: SIX_DAYS_AGO }));
    const { reader } = jobsReader(home);
    const first = await reader.poll();
    expect(first.events.map((e) => e.observedAt)).toEqual([SIX_DAYS_AGO]);
    // not committed: the same event comes again
    expect((await reader.poll()).events).toHaveLength(1);
    first.commit();
    expect((await reader.poll()).events).toEqual([]);
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify(jobState({ state: 'done', sessionId: KNOWN, terminalAt: SIX_DAYS_AGO + DAY })),
    );
    const again = await reader.poll();
    expect(again.events.map((e) => [e.state, e.observedAt])).toEqual([['done', SIX_DAYS_AGO + DAY]]);
  });

  it('JOB_TERMINAL_STATES is done plus the failure states of S-4b', () => {
    expect([...JOB_TERMINAL_STATES].sort()).toEqual(['done', ...JOB_FAILED_STATES].sort());
  });
});
