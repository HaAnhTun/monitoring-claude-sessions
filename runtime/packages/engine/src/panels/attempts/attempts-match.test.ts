// Matching chain-log runs to sessions (06 3.10.6): label, first record in file order, window of -15 s to 600 s, smallest delta,
// ties by later activity and then by the smaller provider id. The pure choice is tested with literal candidates; the last
// block runs the whole path over a real database (`SessionsRepo.attemptCandidates` and `AttemptsRepo.setMatch`).
import { join } from 'node:path';

import { FIXTURE_EPOCH_MS, FakeClock, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { openInstanceDb, type InstanceDb } from '../../db/open.ts';
import type { AttemptCandidate } from '../../db/repos/attempts.ts';
import { SessionsRepo } from '../../db/repos/sessions.ts';
import { withWriteTx } from '../../db/write.ts';
import {
  MATCH_MAX_DELTA_MS,
  MATCH_MIN_DELTA_MS,
  chooseCandidate,
  matchRuns,
  type MatchOptions,
  type MatchRun,
} from './match.ts';
import { createAttemptsStore } from './repo.ts';

const T0 = FIXTURE_EPOCH_MS;
const HOUR = 3_600_000;
const NOW = T0 + 2 * HOUR;
const RUN: MatchRun = { id: 1, part: 'A', startedAt: NOW - 1000 };
const OPTIONS: MatchOptions = { labelPrefix: 'step ', includeUnmatched: false, windowMs: 24 * HOUR, now: NOW };

let counter = 0;
function candidate(over: Partial<AttemptCandidate> = {}): AttemptCandidate {
  counter += 1;
  return {
    sessionRowId: counter,
    sessionId: `session-${String(counter).padStart(4, '0')}`,
    label: 'step A',
    matched: true,
    firstRecordAtMs: RUN.startedAt + 1000,
    lastActivityAtMs: NOW - 1000,
    ...over,
  };
}

function choose(candidates: AttemptCandidate[], over: Partial<MatchOptions> = {}, run: MatchRun = RUN) {
  const got = chooseCandidate(run, candidates, { ...OPTIONS, ...over });
  return got === null ? null : { id: got.candidate.sessionId, deltaMs: got.deltaMs };
}

describe('chooseCandidate: the window', () => {
  it('accepts a first record from 15 s before the START to 600 s after it, both ends included', () => {
    expect(MATCH_MIN_DELTA_MS).toBe(-15_000);
    expect(MATCH_MAX_DELTA_MS).toBe(600_000);
    const edge = (deltaMs: number): ReturnType<typeof choose> =>
      choose([candidate({ sessionId: 'edge', firstRecordAtMs: RUN.startedAt + deltaMs })]);
    expect(edge(-15_000)).toEqual({ id: 'edge', deltaMs: -15_000 });
    expect(edge(-15_001)).toBeNull();
    expect(edge(0)).toEqual({ id: 'edge', deltaMs: 0 });
    expect(edge(600_000)).toEqual({ id: 'edge', deltaMs: 600_000 });
    expect(edge(600_001)).toBeNull();
  });

  it('rejects a candidate without a usable first record', () => {
    expect(choose([candidate({ firstRecordAtMs: null })])).toBeNull();
    expect(choose([candidate({ firstRecordAtMs: 0 })])).toBeNull();
    expect(choose([candidate({ firstRecordAtMs: -5 })])).toBeNull();
  });

  it('rejects a session that was last active longer ago than the window, and keeps one exactly at the limit', () => {
    const limit = NOW - 24 * HOUR;
    expect(choose([candidate({ sessionId: 'old', lastActivityAtMs: limit - 1 })])).toBeNull();
    expect(choose([candidate({ sessionId: 'edge', lastActivityAtMs: limit })])).toEqual({ id: 'edge', deltaMs: 1000 });
  });

  it('honours the configured window', () => {
    const c = candidate({ lastActivityAtMs: NOW - 2 * HOUR });
    expect(choose([c], { windowMs: HOUR })).toBeNull();
    expect(choose([c], { windowMs: 2 * HOUR })).not.toBeNull();
  });
});

describe('chooseCandidate: label and rule match', () => {
  it('needs the label to equal the label prefix plus the part', () => {
    expect(choose([candidate({ label: 'step B' })])).toBeNull();
    expect(choose([candidate({ label: 'step a' })])).toBeNull();
    expect(choose([candidate({ label: 'A' })])).toBeNull();
    expect(choose([candidate({ label: 'A' })], { labelPrefix: '' })).not.toBeNull();
  });

  it('works with an empty part (the label is the prefix alone)', () => {
    const run: MatchRun = { ...RUN, part: '' };
    expect(choose([candidate({ label: 'step ' })], {}, run)).not.toBeNull();
  });

  it('leaves out a session no rule matched unless include_unmatched is on', () => {
    const unmatched = candidate({ sessionId: 'free', matched: false });
    expect(choose([unmatched])).toBeNull();
    expect(choose([unmatched], { includeUnmatched: true })).toEqual({ id: 'free', deltaMs: 1000 });
  });
});

describe('chooseCandidate: the best of several', () => {
  it('takes the smallest delta, and a negative delta is smaller than a positive one', () => {
    const near = candidate({ sessionId: 'near', firstRecordAtMs: RUN.startedAt + 2000 });
    const early = candidate({ sessionId: 'early', firstRecordAtMs: RUN.startedAt - 3000 });
    const late = candidate({ sessionId: 'late', firstRecordAtMs: RUN.startedAt + 90_000 });
    expect(choose([late, near, early])).toEqual({ id: 'early', deltaMs: -3000 });
    expect(choose([late, near])).toEqual({ id: 'near', deltaMs: 2000 });
  });

  it('breaks a tie by the later last activity', () => {
    const quiet = candidate({ sessionId: 'aaa', lastActivityAtMs: NOW - 60_000 });
    const busy = candidate({ sessionId: 'zzz', lastActivityAtMs: NOW - 1000 });
    expect(choose([quiet, busy])?.id).toBe('zzz');
    expect(choose([busy, quiet])?.id).toBe('zzz');
  });

  it('breaks a remaining tie by the smaller session id, whatever the order', () => {
    const b = candidate({ sessionId: 'bbbb', lastActivityAtMs: NOW - 5000 });
    const a = candidate({ sessionId: 'aaaa', lastActivityAtMs: NOW - 5000 });
    expect(choose([b, a])?.id).toBe('aaaa');
    expect(choose([a, b])?.id).toBe('aaaa');
  });

  it('answers null for no candidates', () => {
    expect(choose([])).toBeNull();
  });
});

describe('matchRuns', () => {
  function source(candidates: AttemptCandidate[]): {
    store: Pick<ReturnType<typeof createAttemptsStore>, 'attemptCandidates'>;
    calls: { labels: readonly string[]; since: number }[];
  } {
    const calls: { labels: readonly string[]; since: number }[] = [];
    return {
      calls,
      store: {
        attemptCandidates: (labels, since) => {
          calls.push({ labels, since });
          return candidates.filter((c) => labels.includes(c.label));
        },
      },
    };
  }

  it('asks once for the distinct labels of the runs and the start of the window, and answers one assignment per run', () => {
    const a = candidate({ sessionId: 'sa', label: 'step A' });
    const b = candidate({ sessionId: 'sb', label: 'step B' });
    const { store, calls } = source([a, b]);
    const runs: MatchRun[] = [
      { id: 10, part: 'A', startedAt: RUN.startedAt },
      { id: 11, part: 'B', startedAt: RUN.startedAt },
      { id: 12, part: 'A', startedAt: RUN.startedAt + 500 },
      { id: 13, part: 'C', startedAt: RUN.startedAt },
    ];
    const got = matchRuns(store, runs, OPTIONS);
    expect(calls).toEqual([{ labels: ['step A', 'step B', 'step C'], since: NOW - 24 * HOUR }]);
    expect(got).toEqual([
      { runId: 10, sessionRowId: a.sessionRowId, sessionUid: 'sa', deltaMs: 1000 },
      { runId: 11, sessionRowId: b.sessionRowId, sessionUid: 'sb', deltaMs: 1000 },
      { runId: 12, sessionRowId: a.sessionRowId, sessionUid: 'sa', deltaMs: 500 },
    ]);
  });

  it('does not ask when there is nothing to match', () => {
    const { store, calls } = source([]);
    expect(matchRuns(store, [], OPTIONS)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('matching over a real database', () => {
  const tempDir = useTempDirs();
  const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
  const SCOPE = { instanceId: INSTANCE_ID };
  const open: InstanceDb[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });

  function database(): InstanceDb {
    const db = openInstanceDb({
      path: join(tempDir('attempts-match').path, 'monitor.db'),
      expectedInstanceId: INSTANCE_ID,
      mode: 'serve',
      runtimeVersion: '4.0.0',
      clock: new FakeClock(NOW),
    });
    open.push(db);
    return db;
  }

  function addSession(
    db: InstanceDb,
    uid: string,
    p: { label: string; firstTs: string | null; matched?: boolean; startedAt?: number; lastActivity?: number },
  ): number {
    const sessions = new SessionsRepo(db);
    const session = withWriteTx(db, SCOPE, (tx) =>
      sessions.ensure(SCOPE, tx, { sessionUid: uid, projectId: null, startedAt: p.startedAt ?? NOW }),
    );
    const fileId = db.driver
      .prepare(
        `INSERT INTO transcript_files (path, path_key, kind, session_uid, first_ts_in_order, mtime_seen, discovered_at, updated_at)
         VALUES (?, ?, 'session', ?, ?, ?, ?, ?)`,
      )
      .run([`C:/t/${uid}.jsonl`, `c:/t/${uid}.jsonl`, uid, p.firstTs, p.lastActivity ?? NOW, T0, T0]).lastInsertRowid;
    withWriteTx(db, SCOPE, (tx) =>
      sessions.update(
        SCOPE,
        tx,
        session.id,
        {
          label: p.label,
          transcriptFileId: fileId,
          matched: p.matched ?? true,
          lastActivityAt: p.lastActivity ?? NOW,
        },
        null,
      ),
    );
    return session.id;
  }

  const UID_1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const UID_2 = 'bbbbbbbb-0000-4000-8000-000000000002';

  it('matches on the first record in file order, not on the start of the session or its last activity', () => {
    const db = database();
    const store = createAttemptsStore(db, SCOPE);
    // the session row says it started at the START time, but its first record in file order is 700 s later
    addSession(db, UID_1, {
      label: 'step A',
      firstTs: new Date(RUN.startedAt + 700_000).toISOString(),
      startedAt: RUN.startedAt,
    });
    const second = addSession(db, UID_2, {
      label: 'step A',
      firstTs: new Date(RUN.startedAt + 4000).toISOString(),
      startedAt: RUN.startedAt - 3_000_000,
    });
    const got = matchRuns(store, [RUN], OPTIONS);
    expect(got).toEqual([{ runId: 1, sessionRowId: second, sessionUid: UID_2, deltaMs: 4000 }]);
  });

  it('leaves out a session without a parsable first record and one that no rule matched', () => {
    const db = database();
    const store = createAttemptsStore(db, SCOPE);
    addSession(db, UID_1, { label: 'step A', firstTs: 'not a time' });
    addSession(db, UID_2, { label: 'step A', firstTs: new Date(RUN.startedAt + 1000).toISOString(), matched: false });
    expect(matchRuns(store, [RUN], OPTIONS)).toEqual([]);
    expect(matchRuns(store, [RUN], { ...OPTIONS, includeUnmatched: true })).toHaveLength(1);
  });

  it('ignores a session that went quiet before the window began', () => {
    const db = database();
    const store = createAttemptsStore(db, SCOPE);
    addSession(db, UID_1, {
      label: 'step A',
      firstTs: new Date(RUN.startedAt + 1000).toISOString(),
      startedAt: NOW - 31 * HOUR,
      lastActivity: NOW - 30 * HOUR,
    });
    expect(matchRuns(store, [RUN], OPTIONS)).toEqual([]);
  });
});
