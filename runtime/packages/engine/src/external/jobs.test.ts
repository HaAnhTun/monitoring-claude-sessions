// The daemon job reader (02 7.10): one level of `jobs/`, only `<id>/state.json`, matched by `sessionId` or `resumeSessionId`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FakeClock, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { jobState, writeJob } from '../../test/fixtures/external.ts';
import { nodeExternalFs, type ExternalFs } from './fs.ts';
import { createJobsReader } from './jobs.ts';

const tempDir = useTempDirs();
const KNOWN = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const START = Date.UTC(2026, 9, 12, 8, 0, 0);

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
    const { reader, clock } = jobsReader(home, spy);
    const poll = await reader.poll();
    expect(poll.events).toEqual([
      { k: 'external.job', sessionId: KNOWN, jobId: 'job-1', state: 'working', observedAt: clock.now() },
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
