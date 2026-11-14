import { describe, expect, it } from 'vitest';

import {
  AttemptsPanelSchema,
  CHILD_KINDS,
  ChildKindSchema,
  ChildKindStatsSchema,
  GitPanelSchema,
  LinesPanelSchema,
  LogsPanelSchema,
  MachinePanelSchema,
  PANEL_CONFIG_KEY,
  PANEL_KEYS,
  PanelResponseSchema,
  PanelStatsSchema,
  type PanelKey,
  type PanelResponse,
} from './panels.ts';

const AT = '2026-10-11T10:00:00.000Z';

const DATA: Record<PanelKey, unknown> = {
  git: {
    branch: 'main',
    dirty: 2,
    stopFile: false,
    commits: [{ hash: 'abc1234', subject: 'Add a thing', at: AT }],
    headOid: 'a'.repeat(40),
    detached: false,
    repoState: 'ok',
  },
  machine: {
    sampledAt: AT,
    freeGb: 4.25,
    totalGb: 16,
    usedPct: 73,
    cpuPct: null,
    procs: [{ name: 'node.exe', count: 3, mb: 512 }],
    docker: ['db (Up 2 hours)'],
    platform: 'win32',
    procsSampledAt: AT,
    procsStatus: 'ok',
    dockerEnabled: true,
    dockerSampledAt: AT,
    dockerStatus: 'ok',
  },
  attempts: {
    rows: [
      {
        part: 'p1',
        n: 1,
        model: 'm',
        effort: null,
        startedAt: AT,
        endedAt: null,
        exit: null,
        status: null,
        state: 'RUNNING',
        sessionId: null,
        usage: null,
        attemptId: 5,
        nRaw: '1',
        exitRaw: null,
        endReason: 'open',
        evidence: 'START without END',
        matchDeltaS: null,
      },
    ],
    sourceState: 'ok',
  },
  ledger: { lines: ['| a | b |'], file: 'ledger.md', exists: true, sizeBytes: 12, modifiedAt: AT },
  chainLog: { lines: [], file: null, exists: false, sizeBytes: null, modifiedAt: null },
  logs: {
    files: [{ name: 'a.log', ageS: 3, sizeBytes: 10, tail: ['x'], relPath: 'logs/a.log', modifiedAt: AT }],
    matchedFiles: 1,
  },
};

function response(key: PanelKey, data: unknown = DATA[key]) {
  return {
    key,
    status: 'ok',
    generatedAt: AT,
    sources: [{ source: 'memory', status: 'ok', sampledAt: AT, message: null }],
    data,
  };
}

describe('panel contracts (06 3.3)', () => {
  it('lists the six keys and their config keys', () => {
    expect([...PANEL_KEYS]).toEqual(['git', 'machine', 'attempts', 'ledger', 'chainLog', 'logs']);
    expect(PANEL_CONFIG_KEY).toEqual({
      git: 'git',
      machine: 'machine',
      attempts: 'attempts',
      ledger: 'ledger',
      chainLog: 'chain_log',
      logs: 'logs',
    });
  });

  it.each(PANEL_KEYS)('round trips one sample for %s', (key) => {
    const parsed = PanelResponseSchema.parse(response(key));
    expect(parsed).toEqual(response(key));
    expect(parsed.key).toBe(key);
  });

  it('data may be null when no source produced anything', () => {
    for (const key of PANEL_KEYS) {
      expect(PanelResponseSchema.safeParse({ ...response(key, null), status: 'error' }).success).toBe(true);
    }
  });

  it('rejects a data payload that belongs to another key', () => {
    for (const key of PANEL_KEYS) {
      for (const other of PANEL_KEYS) {
        if (other === key) continue;
        if ((key === 'ledger' && other === 'chainLog') || (key === 'chainLog' && other === 'ledger')) continue;
        expect(PanelResponseSchema.safeParse(response(key, DATA[other])).success, `${key} with ${other} data`).toBe(
          false,
        );
      }
    }
    expect(PanelResponseSchema.safeParse(response('git', DATA.machine)).success).toBe(false);
    expect(PanelResponseSchema.safeParse({ ...response('git'), key: 'nope' }).success).toBe(false);
  });

  it('is strict at every level', () => {
    expect(PanelResponseSchema.safeParse({ ...response('git'), extra: 1 }).success).toBe(false);
    expect(GitPanelSchema.safeParse({ ...(DATA.git as object), extra: 1 }).success).toBe(false);
    expect(MachinePanelSchema.safeParse({ ...(DATA.machine as object), extra: 1 }).success).toBe(false);
    expect(LinesPanelSchema.safeParse({ ...(DATA.ledger as object), extra: 1 }).success).toBe(false);
    expect(LogsPanelSchema.safeParse({ ...(DATA.logs as object), extra: 1 }).success).toBe(false);
    expect(AttemptsPanelSchema.safeParse({ ...(DATA.attempts as object), extra: 1 }).success).toBe(false);
    expect(
      PanelResponseSchema.safeParse({
        ...response('git'),
        sources: [{ source: 'memory', status: 'ok', sampledAt: null, message: null, extra: 1 }],
      }).success,
    ).toBe(false);
  });

  it('checks enumerations of sources, statuses and attempt states', () => {
    const withSource = (source: string, status: string) => ({
      ...response('git'),
      sources: [{ source, status, sampledAt: null, message: null }],
    });
    expect(PanelResponseSchema.safeParse(withSource('git.status', 'unsupported')).success).toBe(true);
    expect(PanelResponseSchema.safeParse(withSource('chainLog', 'pending')).success).toBe(true);
    expect(PanelResponseSchema.safeParse(withSource('nope', 'ok')).success).toBe(false);
    expect(PanelResponseSchema.safeParse(withSource('memory', 'great')).success).toBe(false);
    expect(PanelResponseSchema.safeParse({ ...response('git'), status: 'fine' }).success).toBe(false);
    const attempts = DATA.attempts as { rows: Record<string, unknown>[] };
    const row = attempts.rows[0] ?? {};
    expect(AttemptsPanelSchema.safeParse({ ...attempts, rows: [{ ...row, state: 'IDLE' }] }).success).toBe(false);
    expect(AttemptsPanelSchema.safeParse({ ...attempts, rows: [{ ...row, endReason: 'gone' }] }).success).toBe(false);
  });

  it('PanelResponse<K> narrows the data type by key', () => {
    const parsed = PanelResponseSchema.parse(response('git'));
    if (parsed.key !== 'git') throw new Error('wrong key');
    const git: PanelResponse<'git'> = parsed;
    expect(git.data?.branch).toBe('main');
  });
});

describe('child process contracts (06 3.6, registry C10, C11)', () => {
  it('has the twelve child kinds, without python (ADR 0066), the last three for the user instance (06 2.7)', () => {
    expect([...CHILD_KINDS]).toEqual([
      'powershell.processes',
      'powershell.cmdline',
      'git',
      'docker',
      'ps',
      'taskkill',
      'node',
      'icacls',
      'opener',
      'powershell.shortcut',
      'claude',
      'powershell.picker',
    ]);
    for (const kind of ['powershell.shortcut', 'claude', 'powershell.picker']) {
      expect(ChildKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(ChildKindSchema.safeParse('powershell').success).toBe(false);
    expect(ChildKindSchema.safeParse('opener').success).toBe(true);
    expect(ChildKindSchema.safeParse('bash').success).toBe(false);
    expect(ChildKindSchema.safeParse('python').success).toBe(false);
  });

  it('ChildKindStats is { spawned, failed, timedOut, totalMs } and nothing else', () => {
    expect(ChildKindStatsSchema.safeParse({ spawned: 1, failed: 0, timedOut: 0, totalMs: 12 }).success).toBe(true);
    expect(ChildKindStatsSchema.safeParse({ spawned: 1, failed: 0, timedOut: 0 }).success).toBe(false);
    expect(ChildKindStatsSchema.safeParse({ spawned: 1, failed: 0, timedOut: 0, totalMs: 1, extra: 1 }).success).toBe(
      false,
    );
    expect(ChildKindStatsSchema.safeParse({ spawned: -1, failed: 0, timedOut: 0, totalMs: 1 }).success).toBe(false);
  });

  it('PanelStats holds only the sources that were read, each with its counters', () => {
    expect(PanelStatsSchema.safeParse({}).success).toBe(true);
    expect(
      PanelStatsSchema.safeParse({ memory: { refreshes: 3, failures: 0, lastDurationMs: 1.5, lastStatus: 'ok' } })
        .success,
    ).toBe(true);
    expect(
      PanelStatsSchema.safeParse({ memory: { refreshes: 3, failures: 0, lastDurationMs: null, lastStatus: null } })
        .success,
    ).toBe(true);
    expect(
      PanelStatsSchema.safeParse({ nowhere: { refreshes: 1, failures: 0, lastDurationMs: 1, lastStatus: 'ok' } })
        .success,
    ).toBe(false);
    expect(PanelStatsSchema.safeParse({ memory: { refreshes: 1 } }).success).toBe(false);
  });
});
