import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { hourEndOf, isSegmentName, listSegments, retentionExpired, sealDecision, segmentNameOf } from './segments.ts';

const tempDir = useTempDirs();
const HOUR = 3_600_000;
const SEG = 'hooks-20260102T03Z.ndjson';
const SEG_END = Date.UTC(2026, 0, 2, 4, 0, 0);

describe('segment names (02 2.7)', () => {
  it('accepts only hooks-<YYYYMMDD>T<HH>Z.ndjson', () => {
    expect(isSegmentName(SEG)).toBe(true);
    expect(isSegmentName('hooks-20260102T03Z.jsonl')).toBe(false);
    expect(isSegmentName('hooks-x.jsonl')).toBe(false);
    expect(isSegmentName('notes.txt')).toBe(false);
    expect(isSegmentName('../hooks-20260102T03Z.ndjson')).toBe(false);
  });

  it('names the segment of the UTC hour of received_at and finds the end of that hour', () => {
    const at = Date.UTC(2026, 0, 2, 3, 59, 59, 999);
    expect(segmentNameOf(at)).toBe(SEG);
    expect(hourEndOf(SEG)).toBe(SEG_END);
    // the hour boundary: the next millisecond belongs to the next segment
    expect(segmentNameOf(at + 1)).toBe('hooks-20260102T04Z.ndjson');
    expect(hourEndOf('hooks-20260102T04Z.ndjson')).toBe(SEG_END + HOUR);
  });

  it('refuses an hour that is not 00 to 23', () => {
    expect(isSegmentName('hooks-20260102T24Z.ndjson')).toBe(false);
    expect(() => hourEndOf('hooks-20260102T24Z.ndjson')).toThrow(RangeError);
  });
});

describe('sealDecision (02 2.7 sealing)', () => {
  const base = { segment: SEG, sealGraceMs: 120_000, offset: 500, size: 500, partialBytes: 0 };

  it('keeps a segment while its hour or its grace period is running', () => {
    expect(sealDecision({ ...base, now: SEG_END - 1 })).toBe('keep');
    expect(sealDecision({ ...base, now: SEG_END + 120_000 })).toBe('keep');
  });

  it('seals a fully read segment after hourEnd + grace', () => {
    expect(sealDecision({ ...base, now: SEG_END + 120_001 })).toBe('seal');
  });

  it('keeps a segment that still has unread bytes', () => {
    expect(sealDecision({ ...base, offset: 400, now: SEG_END + 10 * HOUR })).toBe('keep');
  });

  it('seals a torn tail older than the grace as SPOOL_TORN_TAIL', () => {
    expect(sealDecision({ ...base, size: 530, partialBytes: 30, now: SEG_END + 120_001 })).toBe('seal_torn');
    expect(sealDecision({ ...base, size: 530, partialBytes: 30, now: SEG_END + 10 })).toBe('keep');
  });
});

describe('retentionExpired', () => {
  it('is true only after hourEnd + retainHours', () => {
    expect(retentionExpired(SEG, SEG_END + 24 * HOUR, 24)).toBe(false);
    expect(retentionExpired(SEG, SEG_END + 24 * HOUR + 1, 24)).toBe(true);
  });
});

describe('listSegments', () => {
  it('lists segments by name and counts every other entry as foreign without reading it (T-PL-12)', async () => {
    const dir = tempDir('segments-list').path;
    const spool = join(dir, 'spool');
    mkdirSync(spool);
    writeFileSync(join(spool, 'hooks-20260102T04Z.ndjson'), 'bbbb\n');
    writeFileSync(join(spool, SEG), 'aa\n');
    writeFileSync(join(spool, 'notes.txt'), 'private');
    writeFileSync(join(spool, 'hooks-x.jsonl'), 'private');
    mkdirSync(join(spool, 'hooks-20260102T05Z.ndjson'));
    const listing = await listSegments(spool);
    expect(listing.segments.map((s) => [s.name, s.bytes])).toEqual([
      [SEG, 3],
      ['hooks-20260102T04Z.ndjson', 5],
    ]);
    expect(listing.foreign.sort()).toEqual(['hooks-20260102T05Z.ndjson', 'hooks-x.jsonl', 'notes.txt']);
  });

  it('treats a symlink that carries a segment name as foreign', async () => {
    const dir = tempDir('segments-link').path;
    const spool = join(dir, 'spool');
    mkdirSync(spool);
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'x');
    try {
      symlinkSync(outside, join(spool, SEG));
    } catch {
      return; // creating a symlink needs a privilege on some Windows setups: nothing to prove there
    }
    const listing = await listSegments(spool);
    expect(listing.segments).toEqual([]);
    expect(listing.foreign).toEqual([SEG]);
  });

  it('answers an empty listing for a folder that does not exist yet', async () => {
    const listing = await listSegments(join(tempDir('segments-none').path, 'missing'));
    expect(listing).toEqual({ segments: [], foreign: [] });
  });
});
