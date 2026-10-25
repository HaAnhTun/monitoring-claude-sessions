// FIXTURE: invented data for tests
import type {
  InstanceSearchResponse,
  TranscriptEntry,
  TranscriptSearchResponse,
  TranscriptWindowResponse,
} from '@mcs/shared';

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

export type InstanceSearchMatch = InstanceSearchResponse['matches'][number];

export function makeInstanceSearchMatch(overrides: Partial<InstanceSearchMatch> = {}): InstanceSearchMatch {
  return {
    sessionId: sessionId(1),
    sessionLabel: 'FIXTURE session',
    agentId: 'main',
    i: 4,
    k: 'say',
    t: iso(-60),
    name: null,
    snippet: 'FIXTURE text with a needle inside',
    ...overrides,
  };
}

export function makeInstanceSearch(overrides: Partial<InstanceSearchResponse> = {}): InstanceSearchResponse {
  return {
    query: { q: 'needle', kinds: [] },
    matches: [],
    truncated: false,
    coverage: {
      scope: 'instance',
      filesInScope: 3,
      filesScanned: 3,
      filesMissing: 0,
      filesUnreadable: 0,
      bytesInScope: 4096,
      bytesScanned: 4096,
      bytesNotIndexed: 0,
      entriesScanned: 40,
      complete: true,
      stoppedBy: 'complete',
      elapsedMs: 12,
      note: 'FIXTURE coverage note',
    },
    continuation: null,
    ...overrides,
  };
}
