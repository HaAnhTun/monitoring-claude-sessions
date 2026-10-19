// The completion schemas (02 7.13, 03 6.1 and 6.3, registry C16 and C17): the evidence body, the one-selector query with the
// 0..512 attempt part, and the route row.
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_LABEL_MAX,
  COMPLETION_OUTCOMES,
  COMPLETION_PART_MAX,
  COMPLETION_RESOLVED_BY,
  CompletionEvidenceSchema,
  CompletionQuerySchema,
  CompletionResponseSchema,
  withinCodePoints,
} from './completion.ts';
import { fromQuery, toQuery } from './filters.ts';
import { ROUTE_IDS, routeErrors, routes } from './routes.ts';

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function evidence(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'completed',
    state: 'completed',
    basis: 'observed',
    confidence: 'high',
    evidence: [{ kind: 'hook:session_end', at: '2026-10-11T14:05:07.000Z', text: 'session ended (other) 3m ago' }],
    sessionId: SID,
    ruleId: 'S-3b',
    resolvedBy: 'session_id',
    candidates: 1,
    ...over,
  };
}

describe('CompletionEvidenceSchema (registry C16)', () => {
  it('accepts a session answer and an answer of an attempt row that no session matched', () => {
    expect(CompletionEvidenceSchema.safeParse(evidence()).success).toBe(true);
    const unmatched = evidence({
      outcome: 'failed',
      state: 'failed',
      sessionId: null,
      ruleId: 'C-ATT-ENDED',
      resolvedBy: 'attempt_part',
      candidates: 3,
    });
    expect(CompletionEvidenceSchema.parse(unmatched)).toMatchObject({ sessionId: null, resolvedBy: 'attempt_part' });
  });

  it('is strict: an unknown key, a bad enum value, no candidates or more than eight evidence items are refused', () => {
    expect(CompletionEvidenceSchema.safeParse(evidence({ extra: 1 })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ outcome: 'done' })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ state: 'finished' })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ basis: 'guessed' })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ resolvedBy: 'name' })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ candidates: 0 })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ candidates: 1.5 })).success).toBe(false);
    expect(CompletionEvidenceSchema.safeParse(evidence({ sessionId: 'not-a-session' })).success).toBe(false);
    const item = { kind: 'clock:quiet', at: null, text: 'quiet' };
    expect(CompletionEvidenceSchema.safeParse(evidence({ evidence: Array(8).fill(item) })).success).toBe(true);
    expect(CompletionEvidenceSchema.safeParse(evidence({ evidence: Array(9).fill(item) })).success).toBe(false);
  });

  it('lists the outcomes and the ways a target is resolved', () => {
    expect([...COMPLETION_OUTCOMES]).toEqual(['completed', 'failed', 'not_terminal']);
    expect([...COMPLETION_RESOLVED_BY]).toEqual(['session_id', 'label', 'attempt_part']);
  });

  it('the response adds the change-log head and nothing else', () => {
    expect(CompletionResponseSchema.safeParse(evidence()).success).toBe(false);
    expect(CompletionResponseSchema.safeParse(evidence({ asOfSeq: 0 })).success).toBe(true);
    expect(CompletionResponseSchema.safeParse(evidence({ asOfSeq: -1 })).success).toBe(false);
    expect(CompletionResponseSchema.safeParse(evidence({ asOfSeq: 5, extra: true })).success).toBe(false);
  });
});

describe('CompletionQuerySchema (03 6.1, registry C17)', () => {
  it('takes exactly one selector', () => {
    expect(CompletionQuerySchema.safeParse({ session: SID }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({ label: 'nightly build' }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({ attemptPart: 'part-a' }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({}).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ session: SID, label: 'x' }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ label: 'x', attemptPart: 'y' }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ session: SID, label: 'x', attemptPart: 'y' }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ session: SID, other: '1' }).success).toBe(false);
  });

  it('refuses a malformed session id', () => {
    expect(CompletionQuerySchema.safeParse({ session: 'not-a-session' }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ session: SID.toUpperCase() }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ session: '' }).success).toBe(false);
  });

  it('accepts a present but empty attempt part and refuses an empty label', () => {
    expect(CompletionQuerySchema.parse({ attemptPart: '' })).toEqual({ attemptPart: '' });
    expect(CompletionQuerySchema.safeParse({ label: '' }).success).toBe(false);
    // an empty part together with another selector is still two selectors
    expect(CompletionQuerySchema.safeParse({ attemptPart: '', label: 'x' }).success).toBe(false);
  });

  it('bounds the label to 200 and the part to 512 characters', () => {
    expect(COMPLETION_LABEL_MAX).toBe(200);
    expect(COMPLETION_PART_MAX).toBe(512);
    expect(CompletionQuerySchema.safeParse({ label: 'a'.repeat(200) }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({ label: 'a'.repeat(201) }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ label: 'a'.repeat(10_000) }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ attemptPart: 'p'.repeat(512) }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({ attemptPart: 'p'.repeat(513) }).success).toBe(false);
  });

  it('counts code points, so a part of 512 astral characters fits and 513 do not', () => {
    const astral = '\u{1F600}';
    expect(CompletionQuerySchema.safeParse({ attemptPart: astral.repeat(512) }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({ attemptPart: astral.repeat(513) }).success).toBe(false);
    expect(CompletionQuerySchema.safeParse({ label: astral.repeat(200) }).success).toBe(true);
    expect(CompletionQuerySchema.safeParse({ label: astral.repeat(201) }).success).toBe(false);
  });

  it('keeps a label as written: no trimming, wildcards are plain characters', () => {
    expect(CompletionQuerySchema.parse({ label: '  50%_off  ' })).toEqual({ label: '  50%_off  ' });
  });

  it('round-trips through the query text, the empty part included', () => {
    for (const filter of [{ session: SID }, { label: 'a b' }, { attemptPart: '' }, { attemptPart: 'part 1' }]) {
      const text = toQuery(filter);
      expect(fromQuery(CompletionQuerySchema, text)).toEqual(filter);
    }
    expect(toQuery({ attemptPart: '' })).toEqual({ attemptPart: '' });
  });
});

describe('withinCodePoints', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(withinCodePoints('', 0)).toBe(true);
    expect(withinCodePoints('a', 0)).toBe(false);
    expect(withinCodePoints('\u{1F600}\u{1F600}', 2)).toBe(true);
    expect(withinCodePoints('\u{1F600}\u{1F600}\u{1F600}', 2)).toBe(false);
    expect(withinCodePoints('ab\u{1F600}', 3)).toBe(true);
  });

  it('refuses a very long text without walking it', () => {
    expect(withinCodePoints('x'.repeat(1_000_000), 512)).toBe(false);
  });
});

describe('route explainCompletion (03 6.1)', () => {
  it('is registered as GET /api/v3/completion with the 404 code of an unknown target', () => {
    expect(ROUTE_IDS).toContain('explainCompletion');
    const route = routes.explainCompletion;
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/api/v3/completion');
    expect(route.params).toBeNull();
    expect(route.query).toBe(CompletionQuerySchema);
    expect(route.response).toBe(CompletionResponseSchema);
    expect(route.successStatus).toBe(200);
    expect(routeErrors(route)).toContain('completion_target_not_found');
    expect(routeErrors(route)).toContain('validation_failed');
  });
});
