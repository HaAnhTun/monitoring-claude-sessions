import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { killAllTracked, spawnTracked } from '../processes.ts';
import { waitFor } from '../wait.ts';
import { MIN_MARKER_LENGTH, findProcesses } from './process-scan.ts';

afterEach(async () => {
  await killAllTracked();
});

function newMarker(): string {
  return `caw-scan-${randomUUID()}`;
}

describe('findProcesses', () => {
  it('refuses a marker of fewer than 12 characters, however it looks', async () => {
    expect(MIN_MARKER_LENGTH).toBe(12);
    await expect(findProcesses('')).rejects.toThrow(RangeError);
    await expect(findProcesses('node')).rejects.toThrow(RangeError);
    await expect(findProcesses('fake-claude')).rejects.toThrow(RangeError);
    await expect(findProcesses('a'.repeat(11))).rejects.toThrow(RangeError);
  });

  it('says why in the error message of a refusal, and does not repeat the marker', async () => {
    const failure = await findProcesses('secret-abc').then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/at least 12/);
    expect(failure?.message).not.toMatch(/secret-abc/);
  });

  it('finds nothing for a marker that no process carries', async () => {
    await expect(findProcesses(newMarker())).resolves.toEqual([]);
  }, 30_000);

  it('finds a running process by a marker in its command line, with pid, name and command line', async () => {
    const marker = newMarker();
    const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => undefined, 100000)', marker]);
    const found = await waitFor(
      async () => {
        const hits = await findProcesses(marker);
        return hits.length > 0 ? hits : null;
      },
      { timeoutMs: 30_000, intervalMs: 100, what: 'the marked process in the scan' },
    );
    expect(found).toHaveLength(1);
    const [hit] = found;
    expect(hit?.pid).toBe(child.pid);
    expect(hit?.name.toLowerCase()).toContain('node');
    expect(hit?.commandLine).toContain(marker);
  }, 60_000);

  it('does not report the scanner itself, and sees the process go away after it is killed', async () => {
    const marker = newMarker();
    const child = spawnTracked(process.execPath, ['-e', 'setInterval(() => undefined, 100000)', marker]);
    await waitFor(async () => (await findProcesses(marker)).length > 0, { timeoutMs: 30_000, intervalMs: 100 });
    child.kill();
    await child.exited;
    await expect(findProcesses(marker)).resolves.toEqual([]);
  }, 60_000);

  it('matches the marker literally: quotes and shell characters in it do not break the scan', async () => {
    const hits = await findProcesses(`quote'"-$(x)-;&|-${randomUUID()}`);
    expect(hits).toEqual([]);
  }, 30_000);
});
