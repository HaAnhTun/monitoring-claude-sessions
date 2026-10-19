// DA-T-A-2 (03 19.6, 8.2), the projection on table-driven inputs: a field is `null` when every counted message misses it, the
// completeness follows the contributing files, `scannedPct` is the minimum over them and `lowerBound` is set by an unfinalized
// message or an incomplete scan. Also the merge of session aggregates into a project or work item row.
import { describe, expect, it } from 'vitest';

import type { FileFacts } from '../query/transitions.ts';
import { mergeAggregates, type UsageAggregate } from '../tokens/aggregate.ts';
import { reportWindow, tokenUsageFor, totalsOf, usageFilterOf } from './usage.ts';

type Fields = UsageAggregate['sum'];

function fields(over: Partial<Fields> = {}): Fields {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    thinking: 0,
    webSearch: 0,
    webFetch: 0,
    ...over,
  };
}

function aggregate(over: {
  sum?: Partial<Fields>;
  missing?: Partial<Fields>;
  messages: number;
  synthetic?: number;
  unfinalized?: number;
}): UsageAggregate {
  const unfinalized = over.unfinalized ?? 0;
  return {
    sum: fields(over.sum),
    missing: fields(over.missing),
    messages: over.messages,
    synthetic: over.synthetic ?? 0,
    unfinalized,
    outputIsLowerBound: unfinalized > 0,
    complete: true,
    copiedMessages: 0,
  };
}

function file(over: Partial<FileFacts> = {}): FileFacts {
  return {
    fileId: 1,
    sessionUid: 'aaaaaaaa-0000-4000-8000-000000000001',
    agentUid: null,
    agentId: null,
    kind: 'session',
    state: 'active',
    usageState: 'complete',
    headEnd: 0,
    backfillOffset: 1000,
    tailStart: 1000,
    tailOffset: 1000,
    sizeSeen: 1000,
    partialBytes: 0,
    entriesTotal: 10,
    ...over,
  };
}

const MAIN_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;

describe('tokenUsageFor: fields', () => {
  it('has every field null and no total without a message', () => {
    const usage = tokenUsageFor(aggregate({ messages: 0 }), []);
    expect(usage).toMatchObject({
      input: null,
      output: null,
      cacheCreation: null,
      cacheRead: null,
      total: null,
      turns: 0,
      lowerBound: false,
    });
  });

  const CASES: readonly { name: string; messages: number; missing: Partial<Fields>; nulls: readonly string[] }[] = [
    { name: 'a measured zero is not missing', messages: 2, missing: {}, nulls: [] },
    { name: 'every message misses the input', messages: 2, missing: { input: 2 }, nulls: ['input'] },
    { name: 'some messages miss the output: the sum stands', messages: 3, missing: { output: 2 }, nulls: [] },
    {
      name: 'every message misses cache reads and writes',
      messages: 1,
      missing: { cacheRead: 1, cacheCreation: 1 },
      nulls: ['cacheRead', 'cacheCreation'],
    },
  ];

  it.each(CASES)('$name', ({ messages, missing, nulls }) => {
    const usage = tokenUsageFor(
      aggregate({ messages, sum: { input: 5, output: 7, cacheRead: 11, cacheCreation: 13 }, missing }),
      [file()],
    );
    for (const key of MAIN_FIELDS) {
      if (nulls.includes(key)) expect(usage[key], key).toBeNull();
      else expect(usage[key], key).not.toBeNull();
    }
    const present = MAIN_FIELDS.filter((key) => !nulls.includes(key)).reduce((sum, key) => sum + (usage[key] ?? 0), 0);
    expect(usage.total).toBe(present);
    expect(usage.missing).toEqual({
      input: missing.input ?? 0,
      output: missing.output ?? 0,
      cacheCreation: missing.cacheCreation ?? 0,
      cacheRead: missing.cacheRead ?? 0,
    });
  });

  it('counts the synthetic messages as turns and reports them', () => {
    const usage = tokenUsageFor(aggregate({ messages: 3, synthetic: 1, sum: { input: 3 } }), [file()]);
    expect(usage.turns).toBe(3);
    expect(usage.synthetic).toBe(1);
  });
});

describe('tokenUsageFor: completeness, scannedPct and lowerBound', () => {
  const one = aggregate({ messages: 1, sum: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 } });

  const CASES: readonly {
    name: string;
    files: FileFacts[];
    completeness: string;
    scanned: number;
    lower: boolean;
  }[] = [
    { name: 'a complete file', files: [file()], completeness: 'complete', scanned: 100, lower: false },
    {
      name: 'a partial file',
      files: [file({ usageState: 'partial', backfillOffset: 400 })],
      completeness: 'partial',
      scanned: 40,
      lower: true,
    },
    {
      name: 'a skipped backfill is unavailable',
      files: [file({ usageState: 'skipped_backfill', backfillOffset: 0 })],
      completeness: 'unavailable',
      scanned: 0,
      lower: true,
    },
    {
      name: 'one partial file among complete ones makes the whole partial, and scannedPct is the minimum',
      files: [
        file({ fileId: 1 }),
        file({ fileId: 2, usageState: 'partial', backfillOffset: 250 }),
        file({ fileId: 3, usageState: 'partial', backfillOffset: 700 }),
      ],
      completeness: 'partial',
      scanned: 25,
      lower: true,
    },
    {
      name: 'a skipped file among complete ones is partial, not unavailable',
      files: [file({ fileId: 1 }), file({ fileId: 2, usageState: 'skipped_backfill', backfillOffset: 0 })],
      completeness: 'partial',
      scanned: 0,
      lower: true,
    },
    {
      name: 'a retired file does not count',
      files: [file(), file({ fileId: 2, state: 'retired', usageState: 'partial', backfillOffset: 1 })],
      completeness: 'complete',
      scanned: 100,
      lower: false,
    },
    {
      name: 'a journal file does not count',
      files: [file(), file({ fileId: 2, kind: 'workflow_journal', usageState: 'partial', backfillOffset: 1 })],
      completeness: 'complete',
      scanned: 100,
      lower: false,
    },
    {
      name: 'the partial tail bytes are not owed',
      files: [file({ sizeSeen: 1010, partialBytes: 10 })],
      completeness: 'complete',
      scanned: 100,
      lower: false,
    },
  ];

  it.each(CASES)('$name', ({ files, completeness, scanned, lower }) => {
    const usage = tokenUsageFor(one, files);
    expect(usage.completeness).toBe(completeness);
    expect(usage.scannedPct).toBe(scanned);
    expect(usage.lowerBound).toBe(lower);
  });

  it('has no scannedPct without a contributing file', () => {
    expect(tokenUsageFor(one, []).scannedPct).toBeNull();
    expect(tokenUsageFor(one, [file({ state: 'retired' })]).scannedPct).toBeNull();
  });

  it('is a lower bound when a message never got its final record, even when every file is complete', () => {
    const usage = tokenUsageFor(aggregate({ messages: 2, unfinalized: 1, sum: { output: 8 } }), [file()]);
    expect(usage.completeness).toBe('complete');
    expect(usage.unfinalized).toBe(1);
    expect(usage.lowerBound).toBe(true);
  });
});

describe('totalsOf and mergeAggregates', () => {
  it('hands the counters of an aggregate to the projection', () => {
    const agg = aggregate({
      messages: 4,
      synthetic: 1,
      unfinalized: 2,
      sum: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      missing: { input: 1, output: 0, cacheRead: 2, cacheCreation: 3 },
    });
    expect(totalsOf(agg)).toEqual({
      messages: 4,
      synthetic: 1,
      unfinalized: 2,
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
      missingInput: 1,
      missingOutput: 0,
      missingCacheRead: 2,
      missingCacheCreation: 3,
    });
  });

  it('adds sessions up: sums, missing counts, messages, synthetic and unfinalized', () => {
    const a = aggregate({ messages: 2, synthetic: 1, sum: { input: 10, output: 20 }, missing: { cacheRead: 1 } });
    const b = aggregate({
      messages: 3,
      unfinalized: 1,
      sum: { input: 1, output: 2, cacheCreation5m: 4 },
      missing: { cacheRead: 2, input: 1 },
    });
    const merged = mergeAggregates([a, b]);
    expect(merged.sum).toMatchObject({ input: 11, output: 22, cacheCreation5m: 4 });
    expect(merged.missing).toMatchObject({ cacheRead: 3, input: 1 });
    expect([merged.messages, merged.synthetic, merged.unfinalized]).toEqual([5, 1, 1]);
    expect(merged.outputIsLowerBound).toBe(true);
    expect(mergeAggregates([]).messages).toBe(0);
  });
});

describe('the window of a request', () => {
  it('names no time index for a window without a lower bound ("all")', () => {
    expect(usageFilterOf({ fromMs: null, toMs: 5, source: 'range' }, {})).toEqual({});
    expect(usageFilterOf(null, { sessionIds: [], models: ['m'] })).toEqual({ sessionIds: [], models: ['m'] });
    expect(usageFilterOf({ fromMs: 1, toMs: 5, source: 'range' }, { sessionIds: [3] })).toEqual({
      fromMs: 1,
      toMs: 5,
      sessionIds: [3],
    });
  });

  it('shows now as the upper bound of a preset (one millisecond past now) and keeps an explicit past bound', () => {
    const now = Date.UTC(2026, 9, 11, 14);
    expect(reportWindow({ fromMs: now - 1000, toMs: now + 1, source: 'range' }, now)).toEqual({
      from: '2026-10-11T13:59:59.000Z',
      to: '2026-10-11T14:00:00.000Z',
    });
    expect(reportWindow({ fromMs: now - 2000, toMs: now - 1000, source: 'custom' }, now).to).toBe(
      '2026-10-11T13:59:59.000Z',
    );
    expect(reportWindow(null, now)).toEqual({ from: null, to: '2026-10-11T14:00:00.000Z' });
  });
});
