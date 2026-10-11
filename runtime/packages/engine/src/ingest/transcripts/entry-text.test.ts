// Text on demand (02 5.7, T-TR-17): a reference into a provider transcript is turned back into the legacy display entries of
// that one record, after the identity of the file was checked again. Nothing is cached and nothing is persisted.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { FakeClock, TranscriptBuilder, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_INSTANCE_ID } from '../../../test/fixtures/hook-sequences.ts';
import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import { TranscriptFilesRepo } from '../../db/repos/transcript-files.ts';
import { withWriteTx } from '../../db/write.ts';
import { displayEntries } from '../../transcript/entries.ts';
import { readIdentity } from '../tail/file-identity.ts';
import { readEntryText, type TranscriptRef } from './entry-text.ts';

const makeTemp = useTempDirs();
const SCOPE = { instanceId: FIXTURE_INSTANCE_ID };
const SESSION = '55555555-5555-4555-8555-555555555555';

const dbs: InstanceDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

interface Rig {
  readonly db: InstanceDb;
  readonly file: string;
  readonly fileId: number;
  readonly ref: (line: number) => TranscriptRef;
  readonly lines: readonly string[];
  readonly offsets: readonly number[];
}

async function rig(build: (b: TranscriptBuilder) => void, bom = false): Promise<Rig> {
  const dir = makeTemp('entry-text').path;
  const db = openInstanceDb({
    path: path.join(dir, 'monitor.db'),
    expectedInstanceId: FIXTURE_INSTANCE_ID,
    mode: 'serve',
    runtimeVersion: '3.0.0',
    clock: new FakeClock(Date.UTC(2026, 9, 12)),
  });
  dbs.push(db);
  const builder = new TranscriptBuilder({ sessionId: SESSION, cwd: 'FIXTURE/project', startMs: Date.UTC(2026, 0, 1) });
  build(builder);
  const file = path.join(dir, `${SESSION}.jsonl`);
  builder.write(file, { bom });
  const lines = builder.lines();
  const first = bom ? 3 : 0;
  const offsets: number[] = [];
  let at = first;
  for (const line of lines) {
    offsets.push(at);
    at += Buffer.byteLength(line) + 1;
  }
  const files = new TranscriptFilesRepo(db);
  const identity = await readIdentity(file);
  const fileId = withWriteTx(db, SCOPE, (tx) => {
    const { id } = files.register(SCOPE, tx, {
      path: file,
      pathKey: file.toLowerCase(),
      kind: 'session',
      sessionUid: SESSION,
      agentUid: null,
      runUid: null,
      sessionId: null,
      agentId: null,
      workflowRunId: null,
      birthMs: null,
      firstSeenMtimeMs: null,
      mtimeSeen: null,
    });
    files.updateCursors(SCOPE, tx, id, { identity });
    return id;
  });
  const ref = (line: number): TranscriptRef => ({
    fileId,
    byteOffset: offsets[line] ?? -1,
    byteLength: Buffer.byteLength(lines[line] ?? ''),
    ino: identity.ino,
    headHash: identity.headHash,
  });
  return { db, file, fileId, ref, lines, offsets };
}

function simple(b: TranscriptBuilder): void {
  b.user('FIXTURE question');
  const call = b.toolUse('Bash', { command: 'echo FIXTURE' });
  b.toolResult(call, { content: 'FIXTURE output' });
  b.assistant({ messageId: 'msg_a', text: 'FIXTURE answer', stop: 'end_turn' });
}

describe('readEntryText (T-TR-17)', () => {
  it('returns the legacy display entries of the record that the reference points at', async () => {
    const r = await rig(simple);
    for (let line = 0; line < r.lines.length; line += 1) {
      const record: unknown = JSON.parse(r.lines[line] ?? '');
      const got = await readEntryText(r.db, SCOPE, r.ref(line));
      expect(got).toEqual(displayEntries(record, { textChars: 6000 }));
    }
    const first = await readEntryText(r.db, SCOPE, r.ref(0));
    expect(first).toEqual([expect.objectContaining({ k: 'prompt', text: 'FIXTURE question' })]);
  });

  it('applies the legacy clip of the text and honours a smaller one', async () => {
    const long = 'FIXTURE words '.repeat(700);
    const r = await rig((b) => b.user(long));
    const full = await readEntryText(r.db, SCOPE, r.ref(0));
    expect(Array.isArray(full) ? full[0]?.text : null).toContain('... [truncated');
    const short = await readEntryText(r.db, SCOPE, r.ref(0), { textChars: 20 });
    expect(Array.isArray(short) ? Array.from(short[0]?.text ?? '').length : 0).toBeGreaterThan(20);
    expect(Array.isArray(short) ? short[0]?.text : '').toContain('... [truncated');
  });

  it('reads a record of a file that starts with a byte order mark', async () => {
    const r = await rig(simple, true);
    expect(await readEntryText(r.db, SCOPE, r.ref(0))).toEqual([
      expect.objectContaining({ k: 'prompt', text: 'FIXTURE question' }),
    ]);
  });

  it('answers REF_STALE after the file was replaced by another one', async () => {
    const r = await rig(simple);
    const other = new TranscriptBuilder({ sessionId: SESSION, cwd: 'FIXTURE/other', startMs: Date.UTC(2026, 3, 1) });
    other.user('FIXTURE another file').user('FIXTURE and more text to make it longer than the first');
    rmSync(r.file);
    other.write(r.file);
    expect(await readEntryText(r.db, SCOPE, r.ref(0))).toEqual({ ok: false, reason: 'REF_STALE' });
  });

  it('answers REF_STALE when the file was replaced by a rename', async () => {
    const r = await rig(simple);
    const spare = `${r.file}.spare`;
    new TranscriptBuilder({ sessionId: SESSION, cwd: 'FIXTURE/other', startMs: Date.UTC(2026, 4, 1) })
      .user('FIXTURE swapped in')
      .write(spare);
    renameSync(spare, r.file);
    expect(await readEntryText(r.db, SCOPE, r.ref(0))).toEqual({ ok: false, reason: 'REF_STALE' });
  });

  it('answers REF_STALE for a reference made from another identity than the file row holds', async () => {
    const r = await rig(simple);
    expect(await readEntryText(r.db, SCOPE, { ...r.ref(0), headHash: 'f'.repeat(64) })).toEqual({
      ok: false,
      reason: 'REF_STALE',
    });
    expect(await readEntryText(r.db, SCOPE, { ...r.ref(0), ino: '1' })).toEqual({ ok: false, reason: 'REF_STALE' });
  });

  it('answers REF_STALE when the bytes at that place are not a record, or lie beyond the end of the file', async () => {
    const r = await rig(simple);
    const inside = { ...r.ref(1), byteOffset: (r.offsets[1] ?? 0) + 5 };
    expect(await readEntryText(r.db, SCOPE, inside)).toEqual({ ok: false, reason: 'REF_STALE' });
    const beyond = { ...r.ref(1), byteOffset: 10_000_000 };
    expect(await readEntryText(r.db, SCOPE, beyond)).toEqual({ ok: false, reason: 'REF_STALE' });
    expect(await readEntryText(r.db, SCOPE, { ...r.ref(0), byteOffset: -1 })).toEqual({
      ok: false,
      reason: 'REF_STALE',
    });
    expect(await readEntryText(r.db, SCOPE, { ...r.ref(0), byteLength: 0 })).toEqual({
      ok: false,
      reason: 'REF_STALE',
    });
  });

  it('answers NOT_FOUND for an unknown file row and for a file that is gone', async () => {
    const r = await rig(simple);
    expect(await readEntryText(r.db, SCOPE, { ...r.ref(0), fileId: 9999 })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    rmSync(r.file);
    expect(await readEntryText(r.db, SCOPE, r.ref(0))).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('answers READ_FAILED when the path cannot be read as a file, and for a line beyond the one line cap', async () => {
    const r = await rig(simple);
    expect(await readEntryText(r.db, SCOPE, { ...r.ref(0), byteLength: 64 * 1024 * 1024 + 1 })).toEqual({
      ok: false,
      reason: 'READ_FAILED',
    });
    rmSync(r.file);
    mkdirSync(r.file);
    writeFileSync(path.join(r.file, 'inner.txt'), 'x');
    expect(await readEntryText(r.db, SCOPE, r.ref(0))).toEqual({ ok: false, reason: 'READ_FAILED' });
  });

  it('returns no entries for a record that has none, and never caches', async () => {
    const r = await rig((b) => {
      b.user('FIXTURE first');
      b.raw({ type: 'last-prompt', sessionId: SESSION, lastPrompt: 'FIXTURE' });
    });
    expect(await readEntryText(r.db, SCOPE, r.ref(1))).toEqual([]);
    expect(await readEntryText(r.db, SCOPE, r.ref(1))).toEqual([]);
  });
});
