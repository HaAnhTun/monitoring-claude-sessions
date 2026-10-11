// FIXTURE: invented data for tests
import type { ActivityEvent } from '@mcs/shared';

import { iso, sessionId } from './ids.ts';

export { makeEventPage } from './pages.ts';

export function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 1,
    seq: 1,
    key: 't:fixture-record-1',
    sessionId: sessionId(1),
    sessionLabel: 'FIXTURE build step A',
    agentId: null,
    agentLabel: null,
    at: iso(-20),
    atSource: 'record',
    receivedAt: iso(-19),
    sources: ['transcript'],
    source: 'transcript',
    type: 'assistant.message',
    category: 'prompt',
    severity: 'info',
    hookEvent: null,
    entryKind: 'say',
    toolName: null,
    toolUseId: null,
    toolStatus: null,
    durationMs: null,
    summary: 'FIXTURE assistant reply',
    details: {},
    transcriptRef: { agentId: 'main', offset: 0 },
    ...overrides,
  };
}
