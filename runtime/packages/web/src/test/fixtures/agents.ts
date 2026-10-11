// FIXTURE: invented data for tests
import type { AgentNode, Page } from '@mcs/shared';

import { agentId, iso, sessionId } from './ids.ts';
import { makePage } from './pages.ts';
import { makeState, makeUsage } from './sessions.ts';

export function makeAgent(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id: agentId(1),
    seq: 1,
    sessionId: sessionId(1),
    kind: 'subagent',
    depth: 1,
    parentAgentId: 'main',
    parentToolUseId: null,
    agentType: 'FIXTURE type',
    label: 'FIXTURE agent A',
    workflow: null,
    requestShape: null,
    model: 'fixture-model',
    startedAt: iso(-1800),
    lastActivityAt: iso(-60),
    endedAt: null,
    state: makeState('working'),
    usage: makeUsage(),
    toolCallCount: 2,
    errorCount: 0,
    transcript: null,
    ...overrides,
  };
}

export function makeAgentPage(items: AgentNode[], meta: Partial<Omit<Page<AgentNode>, 'items'>> = {}): Page<AgentNode> {
  return makePage(items, meta);
}
