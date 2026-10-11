// T-LF-56 (the evidence golden table of 02 7.1.1 and the viewChanged field list) and the invariants around them.
import { describe, expect, it } from 'vitest';

import { EVIDENCE_FACTS, EVIDENCE_SOURCES, type LifecycleEvidence, type LifecycleView } from './facts.ts';
import { fmtAge, renderEvidence, toApiEvidence, viewChanged } from './rules.ts';

const NOW = 1_791_727_200_000;
const E_ACUTE = String.fromCodePoint(0xe9);
const GRIN = String.fromCodePoint(0x1f600);

function item(
  source: LifecycleEvidence['source'],
  fact: LifecycleEvidence['fact'],
  at: number | null,
  extra: Partial<LifecycleEvidence> = {},
): LifecycleEvidence {
  return { source, fact, at, ...extra };
}

function isPrintableAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return text.length > 0;
}

describe('fmtAge', () => {
  it('formats seconds, minutes, hours and days with floors at every boundary', () => {
    expect(fmtAge(0)).toBe('0s');
    expect(fmtAge(999)).toBe('0s');
    expect(fmtAge(59_999)).toBe('59s');
    expect(fmtAge(60_000)).toBe('1m');
    expect(fmtAge(3_599_999)).toBe('59m');
    expect(fmtAge(3_600_000)).toBe('1h');
    expect(fmtAge(172_799_999)).toBe('47h');
    expect(fmtAge(172_800_000)).toBe('2d');
    expect(fmtAge(86_400_000 * 40)).toBe('40d');
  });

  it('treats a negative age as zero', () => {
    expect(fmtAge(-1)).toBe('0s');
    expect(fmtAge(-86_400_000)).toBe('0s');
  });
});

describe('renderEvidence golden table (T-LF-56, 02 7.1.1)', () => {
  const golden: readonly (readonly [string, LifecycleEvidence, string])[] = [
    ['quiet 12m', item('clock', 'quiet', NOW - 720_000), 'quiet 12m'],
    ['session_end', item('hook', 'session_end', NOW - 180_000, { value: 'other' }), 'session ended (other) 3m ago'],
    [
      'tool_open with count',
      item('hook', 'tool_open', NOW - 95_000, { value: 'Bash', count: 2 }),
      'tool Bash open (2 open) for 1m',
    ],
    ['pid_dead', item('pid', 'pid_dead', NOW - 5000), 'process gone (checked 5s ago)'],
    ['no_records', item('transcript', 'no_records', null), 'no records yet'],
    ['job_state', item('job', 'job_state', NOW - 90_000_000, { value: 'done' }), 'daemon job done 25h ago'],
    ['quiet 3d', item('clock', 'quiet', NOW - 259_200_000), 'quiet 3d'],
    [
      'attempt_row verbatim',
      item('attempts', 'attempt_row', NOW, { value: 'chain log: exit=0 status=PASS' }),
      'chain log: exit=0 status=PASS',
    ],
    ['future at gives 0s', item('clock', 'quiet', NOW + 60_000), 'quiet 0s'],
  ];
  it.each(golden)('%s', (_name, evidence, text) => {
    expect(renderEvidence(evidence, NOW)).toBe(text);
  });

  const rest: readonly (readonly [LifecycleEvidence, string])[] = [
    [item('hook', 'session_end', null), 'session ended (no reason)'],
    [item('hook', 'session_start', NOW - 1000), 'session started (startup) 1s ago'],
    [item('hook', 'session_start', NOW - 1000, { value: 'resume' }), 'session started (resume) 1s ago'],
    [item('hook', 'stop', NOW - 61_000), 'turn stopped 1m ago'],
    [item('hook', 'stop_failure', NOW - 1000, { value: 'rate_limit' }), 'turn failed: rate_limit 1s ago'],
    [item('hook', 'stop_failure', null), 'turn failed: error'],
    [item('transcript', 'end_turn', NOW - 2000), 'assistant ended the turn 2s ago'],
    [item('transcript', 'interrupt', NOW - 2000), 'interrupted by the user 2s ago'],
    [item('hook', 'prompt', NOW - 3_600_000), 'prompt submitted 1h ago'],
    [item('hook', 'tool_open', null), 'tool call open'],
    [item('hook', 'tool_open', NOW - 1000, { value: 'Read', count: 1 }), 'tool Read open for 1s'],
    [item('hook', 'permission_request', NOW - 1000), 'waiting for permission (tool) 1s ago'],
    [item('hook', 'permission_request', NOW - 1000, { value: 'Bash' }), 'waiting for permission (Bash) 1s ago'],
    [item('hook', 'notification', NOW - 1000), 'notification received 1s ago'],
    [item('hook', 'notification', NOW - 1000, { value: 'idle_prompt' }), 'notification idle_prompt 1s ago'],
    [item('registry', 'registry_status', NOW - 1000, { value: 'busy' }), 'registry: busy 1s ago'],
    [item('pid', 'pid_alive', NOW - 1000), 'process alive (checked 1s ago)'],
    [item('pid', 'pid_alive', null), 'process alive'],
    [item('transcript', 'file_written', NOW - 1000), 'transcript written 1s ago'],
    [item('transcript', 'child_active', null, { count: 3 }), '3 child agent(s) active'],
    [item('transcript', 'child_active', null), '1 child agent(s) active'],
    [item('hook', 'background_pending', null, { count: 2 }), '2 background task(s) pending'],
    [item('hook', 'background_pending', null), '1 background task(s) pending'],
    [item('transcript', 'agent_notification', NOW - 1000, { value: 'completed' }), 'agent completed 1s ago'],
    [item('transcript', 'agent_notification', NOW - 1000), 'agent notified 1s ago'],
    [item('hook', 'agent_stop', NOW - 1000), 'agent stopped 1s ago'],
    [item('transcript', 'agent_final', NOW - 1000), 'agent returned its final output 1s ago'],
    [item('hook', 'agent_link', NOW - 1000, { value: 'async_launched' }), 'agent async_launched 1s ago'],
    [item('hook', 'agent_link', NOW - 1000), 'agent linked 1s ago'],
    [item('workflow_file', 'workflow_status', NOW - 1000, { value: 'completed' }), 'workflow completed 1s ago'],
    [item('workflow_file', 'workflow_status', null), 'workflow status unknown'],
    [item('clock', 'quiet', null), 'quiet'],
    [item('transcript', 'api_error', NOW - 1000), 'API error 1s ago'],
    [item('transcript', 'api_error', NOW - 1000, { value: '529' }), 'API error 529 1s ago'],
    [item('hook', 'activity_after_end', NOW - 1000), 'activity after session end 1s ago'],
    [item('hook', 'parent_ended', NOW - 1000), 'parent session ended 1s ago'],
  ];
  it.each(rest)('renders %j', (evidence, text) => {
    expect(renderEvidence(evidence, NOW)).toBe(text);
  });

  it('covers every EvidenceFact with a printable-ASCII template', () => {
    for (const fact of EVIDENCE_FACTS) {
      const text = renderEvidence({ source: 'hook', fact, at: NOW - 1000, value: 'v', count: 2 }, NOW);
      expect(isPrintableAscii(text), `${fact}: ${text}`).toBe(true);
      const bare = renderEvidence({ source: 'hook', fact, at: null }, NOW);
      expect(isPrintableAscii(bare), `${fact} (bare): ${bare}`).toBe(true);
    }
    expect(EVIDENCE_SOURCES).toEqual([
      'hook',
      'transcript',
      'registry',
      'job',
      'attempts',
      'pid',
      'workflow_file',
      'journal',
      'meta',
      'clock',
    ]);
    expect(EVIDENCE_FACTS).toHaveLength(28);
  });

  it('copies characters of the value verbatim and clips the whole text to 120 code points', () => {
    expect(renderEvidence(item('hook', 'session_end', null, { value: `caf${E_ACUTE}` }), NOW)).toBe(
      `session ended (caf${E_ACUTE})`,
    );
    const long = renderEvidence(item('attempts', 'attempt_row', null, { value: 'x'.repeat(200) }), NOW);
    expect(Array.from(long)).toHaveLength(120);
    const astral = renderEvidence(item('attempts', 'attempt_row', null, { value: GRIN.repeat(150) }), NOW);
    expect(Array.from(astral)).toHaveLength(120);
  });
});

describe('toApiEvidence', () => {
  it('maps source:fact to kind, at to an ISO time and the text to the rendered words', () => {
    expect(toApiEvidence(item('hook', 'session_end', NOW - 180_000, { value: 'other' }), NOW)).toEqual({
      kind: 'hook:session_end',
      at: new Date(NOW - 180_000).toISOString(),
      text: 'session ended (other) 3m ago',
    });
    expect(toApiEvidence(item('transcript', 'no_records', null), NOW)).toEqual({
      kind: 'transcript:no_records',
      at: null,
      text: 'no records yet',
    });
  });

  it('gives null for a time that is not a valid date', () => {
    expect(toApiEvidence(item('clock', 'quiet', Number.NaN), NOW).at).toBeNull();
    expect(toApiEvidence(item('clock', 'quiet', 8.64e15 + 1), NOW).at).toBeNull();
  });
});

function view(over: Partial<LifecycleView> = {}): LifecycleView {
  return {
    state: 'working',
    presence: 'open',
    waitReason: null,
    staleKind: null,
    endReason: null,
    turnOutcome: null,
    basis: 'observed',
    confidence: 'high',
    ruleId: 'S-7e',
    evidence: [],
    since: NOW - 1000,
    evaluatedAt: NOW,
    nextCheckAt: NOW + 1000,
    ...over,
  };
}

describe('viewChanged (T-LF-56, 02 7.8 field list)', () => {
  it('is true when there is no previous view', () => {
    expect(viewChanged(null, view())).toBe(true);
  });

  it('is false for an identical view and for changes of evidence, since, evaluatedAt and nextCheckAt only', () => {
    expect(viewChanged(view(), view())).toBe(false);
    expect(
      viewChanged(
        view(),
        view({
          evidence: [item('clock', 'quiet', NOW)],
          since: NOW,
          evaluatedAt: NOW + 5000,
          nextCheckAt: null,
        }),
      ),
    ).toBe(false);
  });

  const fields: readonly (readonly [string, Partial<LifecycleView>])[] = [
    ['state', { state: 'turn_ended' }],
    ['presence', { presence: 'unknown' }],
    ['waitReason', { waitReason: 'user' }],
    ['staleKind', { staleKind: 'silent' }],
    ['endReason', { endReason: 'other' }],
    ['turnOutcome', { turnOutcome: 'ok' }],
    ['basis', { basis: 'inferred' }],
    ['confidence', { confidence: 'low' }],
    ['ruleId', { ruleId: 'S-7b' }],
  ];
  it.each(fields)('is true when only %s differs', (_name, patch) => {
    expect(viewChanged(view(), view(patch))).toBe(true);
    expect(viewChanged(view(patch), view())).toBe(true);
  });
});
