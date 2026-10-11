// FIXTURE: invented data for tests
import type { TranscriptEntry, TranscriptSearchResponse, TranscriptWindowResponse } from '@mcs/shared';

import { iso, sessionId } from './ids.ts';

const KINDS = ['prompt', 'say', 'tool', 'result'] as const;

/** `n` entries with absolute indexes 0..n-1, cycling prompt, say, tool, result. */
export function makeTranscript(n: number): TranscriptEntry[] {
  return Array.from({ length: n }, (_unused, i): TranscriptEntry => {
    const k = KINDS[i % KINDS.length] ?? 'say';
    const base = { i, t: iso(-n + i), k };
    if (k === 'tool') {
      return {
        ...base,
        id: `toolu_${String(i)}`,
        name: 'FixtureTool',
        summary: `FIXTURE tool call ${String(i)}`,
        input: '{}',
      };
    }
    if (k === 'result') return { ...base, id: `toolu_${String(i - 1)}`, text: `FIXTURE tool output ${String(i)}` };
    return { ...base, text: `FIXTURE ${k} text ${String(i)}` };
  });
}

export function makeTranscriptWindow(
  n: number,
  overrides: Partial<TranscriptWindowResponse> = {},
): TranscriptWindowResponse {
  return {
    sessionId: sessionId(1),
    agentId: 'main',
    total: n,
    base: 0,
    from: 0,
    next: n,
    partial: false,
    skippedBytes: 0,
    pendingBytes: 0,
    fileState: 'active',
    asOfSeq: 10,
    events: makeTranscript(n),
    ...overrides,
  };
}

export function makeTranscriptSearch(overrides: Partial<TranscriptSearchResponse> = {}): TranscriptSearchResponse {
  return {
    matches: [],
    count: 0,
    truncated: false,
    partial: false,
    complete: true,
    searchedEntries: 0,
    query: { q: 'needle', kinds: [], tool: null, errors: false },
    coverage: {
      scope: 'session',
      filesInScope: 1,
      filesScanned: 1,
      filesMissing: 0,
      filesUnreadable: 0,
      bytesInScope: 100,
      bytesScanned: 100,
      bytesNotIndexed: 0,
      entriesScanned: 0,
      complete: true,
      stoppedBy: 'complete',
      elapsedMs: 1,
      note: 'FIXTURE coverage note',
    },
    ...overrides,
  };
}
