// @vitest-environment node
import type { TranscriptEntry } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  collectToolNames,
  defaultFilters,
  hasActiveFilters,
  searchQuery,
  unitText,
  unitVisible,
  type TranscriptFilters,
} from './filters.ts';
import { pairEvents } from './timeline-model.ts';

const T = '2026-10-11T10:00:00Z';

function ev(i: number, k: TranscriptEntry['k'], extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { i, t: T, k, ...extra };
}

const sample: TranscriptEntry[] = [
  ev(0, 'prompt', { text: 'Do the thing' }),
  ev(1, 'say', { text: 'Sure, running ls' }),
  ev(2, 'tool', { id: 'a', name: 'Bash', summary: 'ls -la', input: '{"command":"ls -la"}' }),
  ev(3, 'tool', { id: 'b', name: 'Read', summary: 'file.txt', input: '{}' }),
  { ...ev(4, 'result', { id: 'a', text: 'total 0', err: false }), t: '2026-10-11T10:00:05Z' },
  ev(5, 'think', { text: 'hmm' }),
  ev(6, 'result', { id: 'zzz', text: 'orphan error', err: true }),
];

describe('filters', () => {
  it('legacy: filters: kinds, text, tool, errors only', () => {
    const units = pairEvents(sample);
    const f = defaultFilters({ showPrompts: true, showThinking: true });
    const vis = (ff: TranscriptFilters): string[] => units.filter((u) => unitVisible(u, ff)).map((u) => u.key);
    expect(vis(f)).toEqual(['e0', 'e1', 'e2', 'e3', 'e5', 'e6']);
    expect(vis(defaultFilters())).toEqual(['e1', 'e2', 'e3', 'e6']); // prompts and thinking off by default
    expect(vis({ ...f, q: 'LS -la' })).toEqual(['e2']); // case-insensitive, tool summary
    expect(vis({ ...f, q: 'total 0' })).toEqual(['e2']); // matches the nested result text
    expect(vis({ ...f, tool: 'Read' })).toEqual(['e3']);
    expect(vis({ ...f, errorsOnly: true })).toEqual(['e6']);
    expect(vis({ ...f, kinds: { ...f.kinds, tool: false } })).toEqual(['e0', 'e1', 'e2', 'e5', 'e6']); // e2 still has a result
    expect(vis({ ...f, kinds: { ...f.kinds, tool: false, result: false } })).toEqual(['e0', 'e1', 'e5']);
    expect(collectToolNames(units)).toEqual(['Bash', 'Read']);
    expect(hasActiveFilters(f)).toBe(false);
    expect(hasActiveFilters({ ...f, q: ' x ' })).toBe(true);
  });

  it('defaultFilters reads the instance ui defaults (tools on unless showTools is false)', () => {
    expect(defaultFilters().kinds).toEqual({ prompt: false, say: true, think: false, tool: true, result: true });
    expect(defaultFilters({ showTools: false }).kinds.tool).toBe(false);
    expect(defaultFilters({ showPrompts: true }).kinds.prompt).toBe(true);
    expect(defaultFilters({ showThinking: true }).kinds.think).toBe(true);
  });

  it('unitText folds tool and result text once and caches it per entry', () => {
    const units = pairEvents(sample);
    const tool = units.find((u) => u.key === 'e2');
    expect(tool !== undefined && unitText(tool)).toContain('ls -la');
    expect(tool !== undefined && unitText(tool)).toContain('total 0');
    expect(tool !== undefined && unitText(tool)).toBe(tool !== undefined ? unitText(tool) : '');
  });

  it('legacy: searchQuery mirrors filters', () => {
    const f = { ...defaultFilters(), q: ' foo bar ', tool: 'Bash', errorsOnly: true };
    expect(searchQuery(f, 'sid1', '')).toEqual({
      session: 'sid1',
      q: 'foo bar',
      kinds: ['say', 'tool', 'result'],
      tool: 'Bash',
      errors: true,
      limit: 200,
    });
    const all = searchQuery(
      { ...f, kinds: { prompt: true, say: true, think: true, tool: true, result: true } },
      's',
      'a',
      50,
    );
    expect(all.kinds).toBeUndefined();
    expect(all.agent).toBe('a');
    expect(all.limit).toBe(50);
  });

  it('searchQuery omits empty parts', () => {
    const q = searchQuery(defaultFilters(), 's1', null);
    expect(q).toEqual({ session: 's1', kinds: ['say', 'tool', 'result'], limit: 200 });
    expect('agent' in q).toBe(false);
    expect('q' in q).toBe(false);
    expect('errors' in q).toBe(false);
  });
});
