// The external evidence fixtures themselves (`test/fixtures/external.ts`): the files they write have the shape the readers expect.
// It lives here because only `src/**/*.test.ts` belongs to the unit project.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { CANARY, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { JOB_FIXTURE_TIME, jobState, registryEntry, writeJob, writeRegistry } from '../../test/fixtures/external.ts';

const tempDir = useTempDirs();
const SESSION = '00000000-0000-4000-8000-0000000000e1';

describe('registry fixture', () => {
  it('writes <pid>.json with the survey keys and waitingFor only when asked', () => {
    const home = tempDir('external-fixture').path;
    const dir = writeRegistry(home, [
      registryEntry({ pid: 4242, sessionId: SESSION, status: 'waiting', waitingFor: 'permission prompt' }),
      registryEntry({ pid: 4243, sessionId: SESSION, kind: 'bg' }),
    ]);
    expect(readdirSync(dir).sort()).toEqual(['4242.json', '4243.json']);
    const waiting: unknown = JSON.parse(readFileSync(path.join(dir, '4242.json'), 'utf8'));
    expect(waiting).toMatchObject({
      pid: 4242,
      sessionId: SESSION,
      status: 'waiting',
      waitingFor: 'permission prompt',
    });
    const idle: unknown = JSON.parse(readFileSync(path.join(dir, '4243.json'), 'utf8'));
    expect(idle).toMatchObject({ status: 'idle', kind: 'bg' });
    expect(idle).not.toHaveProperty('waitingFor');
  });

  it('writes a .key decoy that holds the canary when asked', () => {
    const home = tempDir('external-fixture').path;
    const dir = writeRegistry(home, [registryEntry({ pid: 4242, sessionId: SESSION })], { keyDecoys: true });
    expect(readFileSync(path.join(dir, '4242.key'), 'utf8')).toBe(CANARY.key);
  });

  it('refuses an entry without a numeric pid', () => {
    const home = tempDir('external-fixture').path;
    expect(() => writeRegistry(home, [{ sessionId: SESSION }])).toThrow(/numeric pid/);
  });
});

describe('job fixture', () => {
  it('writes state.json and unrelated temp files below the job folder', () => {
    const home = tempDir('external-fixture').path;
    const dir = writeJob(home, 'job-1', jobState({ state: 'working', sessionId: SESSION }));
    const state: unknown = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
    expect(state).toMatchObject({ state: 'working', backend: 'daemon', sessionId: SESSION });
    expect(existsSync(path.join(dir, 'tmp', 'work-1.txt'))).toBe(true);
  });

  it('writes ISO text and the terminal fields of an ended job by default (the shape of the real files)', () => {
    const iso = new Date(JOB_FIXTURE_TIME).toISOString();
    const done = jobState({ state: 'done', sessionId: SESSION, terminalAt: JOB_FIXTURE_TIME + 5000 });
    expect(done).toMatchObject({
      createdAt: iso,
      updatedAt: iso,
      firstTerminalAt: new Date(JOB_FIXTURE_TIME + 5000).toISOString(),
      lastTerminalAt: new Date(JOB_FIXTURE_TIME + 5000).toISOString(),
    });
    const working = jobState({ state: 'working', sessionId: SESSION, updatedAt: JOB_FIXTURE_TIME + 1000 });
    expect(working).toMatchObject({ createdAt: iso, updatedAt: new Date(JOB_FIXTURE_TIME + 1000).toISOString() });
    expect(working).not.toHaveProperty('lastTerminalAt');
    expect(working).not.toHaveProperty('firstTerminalAt');
  });

  it('writes epoch milliseconds with epochMs', () => {
    expect(jobState({ state: 'failed', sessionId: SESSION, epochMs: true })).toMatchObject({
      createdAt: JOB_FIXTURE_TIME,
      updatedAt: JOB_FIXTURE_TIME,
      firstTerminalAt: JOB_FIXTURE_TIME,
      lastTerminalAt: JOB_FIXTURE_TIME,
    });
  });

  it('keeps resumeSessionId apart from sessionId', () => {
    expect(jobState({ state: 'done', resumeSessionId: SESSION })).toMatchObject({ resumeSessionId: SESSION });
    expect(jobState({ state: 'done', resumeSessionId: SESSION })).not.toHaveProperty('sessionId');
  });
});
