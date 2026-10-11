// FIXTURE: invented data for tests
import type { WorkItem, WorkItemBoard } from '@mcs/shared';

import { iso, sessionId } from './ids.ts';

export function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 1,
    key: 'fixture-1',
    seq: 1,
    title: 'FIXTURE work item A',
    source: 'declared',
    rule: 'W-DECL',
    state: 'working',
    boardReason: 'FIXTURE board reason',
    evidence: [],
    since: iso(-3600),
    sessionIds: [sessionId(1)],
    sessionCount: 1,
    lastActivityAt: iso(-30),
    usage: null,
    ...overrides,
  };
}

export function makeWorkItemBoard(overrides: Partial<WorkItemBoard> = {}): WorkItemBoard {
  return {
    asOfSeq: 10,
    derivation: 'FIXTURE derivation text',
    items: [makeWorkItem()],
    truncated: false,
    ...overrides,
  };
}
