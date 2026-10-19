// T-ISO-05 (01 3.5, defence in depth of INV-04): the database of instance B copied into the workspace of A is never opened
// as A's. The server of A finds `meta.instance_id` of B, exits 11 (`IDENTITY_MISMATCH`), `start` reports it, nothing keeps
// running and the copied file is byte for byte what it was.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CliEnvelopeSchema } from '@mcs/shared';
import { assertPortClosed, spawnTracked } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { serverEntryPath, twoWorkspaces } from './_setup.ts';

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('database identity (T-ISO-05)', () => {
  it("T-ISO-05 a copy of B's data/monitor.db in A: the server exits 11, start reports IDENTITY_MISMATCH, A's copy is untouched", async () => {
    const { a, b } = await twoWorkspaces();
    // B runs once so that it owns a real database, then stops so that the file is complete on disk
    const running = await b.start();
    await running.handle.stop();
    expect(existsSync(b.dbPath)).toBe(true);

    mkdirSync(dirname(a.dbPath), { recursive: true });
    copyFileSync(b.dbPath, a.dbPath);
    const before = sha256(a.dbPath);
    expect(before).toBe(sha256(b.dbPath));

    // the server by hand: exit code 11, nothing listening
    const server = spawnTracked(
      process.execPath,
      [
        serverEntryPath(),
        'serve',
        `--mcs-instance=${a.instanceId}`,
        `--instance-dir=${a.dir}`,
        `--port=${String(a.configuredPort)}`,
      ],
      { env: a.env },
    );
    expect(await server.exited).toBe(11);
    await assertPortClosed(a.configuredPort);
    expect(sha256(a.dbPath)).toBe(before);

    // `start` reports the same refusal and starts nothing
    const started = await a.mcs(['start', '--task', 'a', '--port', String(a.configuredPort), '--json']);
    expect(started.code).toBe(1);
    const envelope = CliEnvelopeSchema.parse(JSON.parse(started.stdout));
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.message).toContain('IDENTITY_MISMATCH');
    expect(envelope.error?.details).toMatchObject({ exitCode: 11 });
    expect(sha256(a.dbPath)).toBe(before);
    expect(a.readState()).toBeNull();
    expect(await a.markerProcesses()).toEqual([]);
    await assertPortClosed(a.configuredPort);
    // B's own file was only ever read
    expect(sha256(b.dbPath)).toBe(before);
  }, 180_000);
});
