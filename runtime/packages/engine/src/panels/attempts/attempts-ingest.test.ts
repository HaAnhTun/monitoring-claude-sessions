// The attempts tick over a real database and a chain log in a temp folder (06 3.10.3, 3.10.8): rows from START and END lines,
// the stored offset and identity, rebuilds, and the panel read. The evidence side is in `attempts-evidence.test.ts`.
import { mkdirSync, rmSync, statSync } from 'node:fs';

import { AttemptsPanelSchema, type TokenUsage } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import {
  BASE_MS,
  MINUTE,
  SCOPE,
  START_PATTERN,
  endLine,
  logTime,
  startLine,
  stubWriter,
  uid,
  useAttemptsHarness,
  type AttemptsHarness,
} from '../../../test/fixtures/attempts-harness.ts';
import { pathKey } from '../../platform/paths.ts';
import {
  ATTEMPTS_LIMITS,
  attemptsSettings,
  configHash,
  createAttemptsState,
  tickAttempts,
  type AttemptsState,
} from './ingest.ts';
import { readAttemptsPanel } from './repo.ts';

const harness = useAttemptsHarness();
const PERF_FACTOR = Number(process.env['MCS_PERF_FACTOR'] ?? '1') || 1;

/** One tick with a stub writer that takes everything. */
async function tick(
  h: AttemptsHarness,
  state: AttemptsState = createAttemptsState(),
  limits?: { sliceBytes?: number; sliceDeadlineMs?: number; rangeBytes?: number },
) {
  const w = stubWriter();
  const result = await tickAttempts(h.context(), { writer: w, state, ...(limits === undefined ? {} : { limits }) });
  return { result, w, state };
}

function rows(h: AttemptsHarness) {
  return h.store.latestRuns(500_000);
}

/** The chain log of the demo: six parts, A and B finished, the rest running. */
function sixParts(): string {
  return [
    startLine(BASE_MS, 'A'),
    endLine(BASE_MS + 30_000, 'A', 0, 'PASS'),
    startLine(BASE_MS + 1000, 'B', 2),
    endLine(BASE_MS + 40_000, 'B', 1, 'FAIL'),
    startLine(BASE_MS + 2000, 'C', 3),
    startLine(BASE_MS + 3000, 'D', 4),
    startLine(BASE_MS + 4000, 'E', 5),
    startLine(BASE_MS + 5000, 'F', 6),
    '',
  ].join('\n');
}

describe('the rows of a chain log', () => {
  it('turns a chain log with six parts A to F into six rows', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const { result } = await tick(h);
    expect(result).toEqual({ state: 'ok', linesRead: 8, rowsChanged: 6 + 2, eventsSubmitted: 0 });
    const got = rows(h);
    expect(got.map((r) => r.part)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(got.map((r) => r.state)).toEqual(['COMPLETED', 'FAILED', 'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING']);
    expect(got.map((r) => r.endReason)).toEqual(['ended', 'ended', 'open', 'open', 'open', 'open']);
    expect(got[0]).toMatchObject({
      generation: 1,
      nRaw: '1',
      model: 'haiku',
      effort: 'low',
      startedAt: BASE_MS,
      endedAt: BASE_MS + 30_000,
      exitRaw: '0',
      statusRaw: 'PASS',
      evidence: 'chain log: exit=0 status=PASS',
      sessionRowId: null,
    });
    expect(got[1]).toMatchObject({ exitRaw: '1', statusRaw: 'FAIL', evidence: 'chain log: exit=1 status=FAIL' });
    expect(got[2]).toMatchObject({ evidence: 'chain log: started, no END yet', endedAt: null });
  });

  it('stores the offset after the last whole line, and a tick without new bytes writes nothing', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    const source = h.store.getSource(pathKey(h.logFile));
    expect(source).toMatchObject({
      generation: 1,
      readOffset: statSync(h.logFile).size,
    });
    expect(source?.configSha256).toMatch(/^[0-9a-f]{64}$/);
    const head = h.db.headSeq();
    h.clock.advance(2000);
    const { result } = await tick(h, state);
    expect(result).toEqual({ state: 'ok', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 });
    expect(h.db.headSeq()).toBe(head);
    expect(h.store.getSource(pathKey(h.logFile))?.updatedAt).toBe(source?.updatedAt);
  });

  it('closes C on the tick after its END was appended, and not before', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    h.appendLog(`${endLine(BASE_MS + 90_000, 'C', 0, 'DONE')}\n`);
    // the bytes are there, but the rows only change with the tick
    expect(rows(h).find((r) => r.part === 'C')?.state).toBe('RUNNING');
    const { result } = await tick(h, state);
    expect(result).toMatchObject({ linesRead: 1, rowsChanged: 1 });
    expect(rows(h).find((r) => r.part === 'C')).toMatchObject({
      state: 'COMPLETED',
      endReason: 'ended',
      endedAt: BASE_MS + 90_000,
      statusRaw: 'DONE',
    });
    expect(
      rows(h)
        .filter((r) => r.endReason === 'open')
        .map((r) => r.part),
    ).toEqual(['D', 'E', 'F']);
  });

  it('supersedes an open run when a later START of the same part arrives', async () => {
    const h = harness();
    h.writeLog(`${startLine(BASE_MS, 'A', 1)}\n${startLine(BASE_MS + 60_000, 'A', 2)}\n`);
    await tick(h);
    const got = rows(h);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({
      endReason: 'superseded',
      state: 'UNKNOWN',
      evidence: 'chain log: a later START for part A superseded this attempt',
    });
    expect(got[1]).toMatchObject({ endReason: 'open', state: 'RUNNING', nRaw: '2' });
  });

  it('keeps two interleaved parts apart', async () => {
    const h = harness();
    h.writeLog(
      [
        startLine(BASE_MS, 'A'),
        startLine(BASE_MS + 1000, 'B'),
        endLine(BASE_MS + 2000, 'A', 0, 'PASS'),
        endLine(BASE_MS + 3000, 'B', 1, 'FAIL'),
        '',
      ].join('\n'),
    );
    await tick(h);
    expect(rows(h).map((r) => [r.part, r.state])).toEqual([
      ['A', 'COMPLETED'],
      ['B', 'FAILED'],
    ]);
  });

  it('ignores an END before any START, an END of a part that is not open, and an END without a part', async () => {
    const h = harness({
      end: String.raw`^(?<time>\S+ \S+) (?:STEP (?<part>[A-Z]) )?END exit=(?<exit>[0-9]+) status=(?<status>[A-Z_]+)`,
    });
    h.writeLog(
      [
        endLine(BASE_MS, 'A', 0, 'PASS'),
        startLine(BASE_MS + 1000, 'B'),
        endLine(BASE_MS + 2000, 'C', 0, 'PASS'),
        `${logTime(BASE_MS + 3000)} END exit=0 status=PASS`,
        '',
      ].join('\n'),
    );
    const { result } = await tick(h);
    expect(rows(h).map((r) => [r.part, r.endReason])).toEqual([['B', 'open']]);
    expect(result.rowsChanged).toBe(1);
  });

  it('accepts a START without a part group: the part is empty', async () => {
    const h = harness({
      start: String.raw`^(?<time>\S+ \S+) BEGIN`,
      end: String.raw`^(?<time>\S+ \S+) FINISH (?<part>)(?<exit>[0-9]+)(?<status>)`,
      labelPrefix: 'run',
    });
    h.writeLog(`${logTime(BASE_MS)} BEGIN\n${logTime(BASE_MS + 5000)} FINISH 0\n`);
    await tick(h);
    expect(rows(h)).toMatchObject([
      { part: '', nRaw: null, model: null, effort: null, state: 'COMPLETED', exitRaw: '0' },
    ]);
  });

  it('skips a START whose time does not parse, with no row and no END attempt', async () => {
    const h = harness();
    h.writeLog(`not-a-date 10:00:00 STEP A START attempt 1 model haiku effort low\n${startLine(BASE_MS, 'B')}\n`);
    const { result } = await tick(h);
    expect(result.linesRead).toBe(2);
    expect(rows(h).map((r) => r.part)).toEqual(['B']);
  });

  it('uses the start time for an END whose time does not parse', async () => {
    const h = harness();
    h.writeLog(`${startLine(BASE_MS, 'A')}\nnot-a-date 10:00:00 STEP A END exit=0 status=PASS\n`);
    await tick(h);
    expect(rows(h)[0]).toMatchObject({ state: 'COMPLETED', endedAt: BASE_MS });
  });

  it('cuts a line at the line breaks of Python (a lone CR), with the right offsets', async () => {
    const h = harness();
    h.writeLog(
      `${startLine(BASE_MS, 'A')}\r${endLine(BASE_MS + 1000, 'A', 0, 'PASS')}\n${startLine(BASE_MS + 2000, 'B')}\n`,
    );
    await tick(h);
    const got = rows(h);
    expect(got.map((r) => [r.part, r.state])).toEqual([
      ['A', 'COMPLETED'],
      ['B', 'RUNNING'],
    ]);
    const first = startLine(BASE_MS, 'A');
    expect(got[0]?.startOffset).toBe(0);
    expect(got[0]?.endOffset).toBe(first.length + 1);
    expect(got[1]?.startOffset).toBe(first.length + 1 + endLine(BASE_MS + 1000, 'A', 0, 'PASS').length + 1);
  });
});

describe('line endings and unterminated lines', () => {
  it('reads CRLF lines without the CR in the last group', async () => {
    const h = harness({
      end: String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) END exit=(?<exit>[0-9]+) status=(?<status>.*)`,
    });
    h.writeLog(`${startLine(BASE_MS, 'A')}\r\n${endLine(BASE_MS + 1000, 'A', 0, 'PASS')}\r\n`);
    await tick(h);
    expect(rows(h)[0]).toMatchObject({ state: 'COMPLETED', statusRaw: 'PASS' });
  });

  it('reads a file that starts with a byte order mark', async () => {
    const h = harness();
    h.writeLog(`${String.fromCharCode(0xfeff)}${startLine(BASE_MS, 'A')}\n`);
    await tick(h);
    expect(rows(h).map((r) => r.part)).toEqual(['A']);
    expect(rows(h)[0]?.startOffset).toBe(3);
  });

  it('does not consume a line without its LF, and takes it when the LF arrives', async () => {
    const h = harness();
    const open = `${startLine(BASE_MS, 'A')}\n`;
    const end = endLine(BASE_MS + 1000, 'A', 0, 'PASS');
    h.writeLog(open + end);
    const state = createAttemptsState();
    const first = await tick(h, state);
    expect(first.result.linesRead).toBe(1);
    expect(h.store.getSource(pathKey(h.logFile))?.readOffset).toBe(open.length);
    expect(rows(h)[0]?.state).toBe('RUNNING');
    h.appendLog('\n');
    const second = await tick(h, state);
    expect(second.result.linesRead).toBe(1);
    expect(rows(h)[0]?.state).toBe('COMPLETED');
  });

  it('survives invalid UTF-8 in a line', async () => {
    const h = harness();
    h.writeLog(Buffer.concat([Buffer.from(`${startLine(BASE_MS, 'A')}\n`), Buffer.from([0xff, 0xfe, 0x0a])]));
    await expect(tick(h)).resolves.toMatchObject({ result: { state: 'ok' } });
    expect(rows(h)).toHaveLength(1);
  });
});

describe('the file changes under the tick', () => {
  it('starts generation 2 when the file is truncated, and keeps the old rows', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    h.writeLog(`${startLine(BASE_MS + 10 * MINUTE, 'A', 9)}\n`);
    h.clock.advance(2000);
    const { result } = await tick(h, state);
    expect(result).toMatchObject({ state: 'ok', linesRead: 1, rowsChanged: 1 });
    const got = rows(h);
    expect(got).toHaveLength(7);
    expect(got.filter((r) => r.generation === 1)).toHaveLength(6);
    expect(got.filter((r) => r.generation === 2)).toMatchObject([{ part: 'A', nRaw: '9', startOffset: 0 }]);
    // the part A of generation 1 ended: the open run of generation 2 is a different run
    expect(got.find((r) => r.generation === 1 && r.part === 'A')?.state).toBe('COMPLETED');
    expect(h.store.getSource(pathKey(h.logFile))).toMatchObject({ generation: 2 });
  });

  it('notices a file that was replaced by another one of the same size', async () => {
    const h = harness();
    const old = `${startLine(BASE_MS, 'A')}\n${startLine(BASE_MS + 1000, 'B')}\n`;
    h.writeLog(old);
    const state = createAttemptsState();
    await tick(h, state);
    const next = `${startLine(BASE_MS + 5000, 'C')}\n${startLine(BASE_MS + 6000, 'D')}\n`;
    expect(next.length).toBe(old.length);
    h.writeLog(next);
    h.clock.advance(2000);
    await tick(h, state);
    expect(rows(h).map((r) => [r.generation, r.part])).toEqual([
      [1, 'A'],
      [1, 'B'],
      [2, 'C'],
      [2, 'D'],
    ]);
  });

  it('continues after a restart from the stored offset and reads nothing twice', async () => {
    const h = harness();
    h.writeLog(sixParts());
    await tick(h);
    h.appendLog(`${endLine(BASE_MS + 90_000, 'C', 0, 'PASS')}\n`);
    // a new state: a new process
    const { result } = await tick(h, createAttemptsState());
    expect(result).toMatchObject({ linesRead: 1, rowsChanged: 1 });
    expect(rows(h)).toHaveLength(6);
  });

  it('answers missing for a file that is not there and keeps the rows', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    rmSync(h.logFile);
    const { result } = await tick(h, state);
    expect(result).toEqual({ state: 'missing', linesRead: 0, rowsChanged: 0, eventsSubmitted: 0 });
    expect(rows(h)).toHaveLength(6);
  });

  it('answers error for a chain log that is a folder, and logs the failure once', async () => {
    const h = harness();
    mkdirSync(h.logFile);
    const state = createAttemptsState();
    expect((await tick(h, state)).result.state).toBe('error');
    expect((await tick(h, state)).result.state).toBe('error');
    expect(h.warns.warnings).toEqual([{ event: 'attempts_read_failed', fields: { code: 'EISDIR' } }]);
  });
});

describe('configuration', () => {
  it('does nothing when attempts or chain_log is not set', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const ctx = h.context();
    const noAttempts = {
      ...ctx,
      config: { ...ctx.config, monitor: { ...ctx.config.monitor, attempts: null }, patterns: { attempts: null } },
    };
    const noLog = { ...ctx, config: { ...ctx.config, monitor: { ...ctx.config.monitor, chain_log: null } } };
    const emptyLog = { ...ctx, config: { ...ctx.config, monitor: { ...ctx.config.monitor, chain_log: '' } } };
    for (const c of [noAttempts, noLog, emptyLog]) {
      const w = stubWriter();
      await expect(tickAttempts(c, { writer: w, state: createAttemptsState() })).resolves.toEqual({
        state: 'not_configured',
        linesRead: 0,
        rowsChanged: 0,
        eventsSubmitted: 0,
      });
    }
    expect(rows(h)).toEqual([]);
    expect(attemptsSettings(noLog.config)).toBeNull();
  });

  it('hashes the patterns, the prefix and the time format, and nothing else', () => {
    const h = harness();
    const settings = attemptsSettings(h.context().config);
    expect(settings).not.toBeNull();
    if (settings === null) return;
    const base = configHash(settings);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash({ ...settings, includeUnmatched: true, windowMs: 1 })).toBe(base);
    expect(configHash({ ...settings, labelPrefix: 'x' })).not.toBe(base);
    expect(configHash({ ...settings, timeFormat: '%d' })).not.toBe(base);
    expect(configHash({ ...settings, startSource: 'y' })).not.toBe(base);
    expect(configHash({ ...settings, endSource: 'y' })).not.toBe(base);
    expect(settings).toMatchObject({ timeFormat: '%Y-%m-%d %H:%M:%S', labelPrefix: 'step ', windowMs: 24 * 3_600_000 });
  });

  it('rebuilds the rows when a pattern changes: generation 1 again, the offset read from 0', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    h.writeLog(`${sixParts()}${endLine(BASE_MS + 90_000, 'C', 0, 'PASS')}\n`);
    h.config.start = `${START_PATTERN}.*`;
    h.clock.advance(2000);
    const { result } = await tick(h, state);
    expect(result).toMatchObject({ state: 'ok', linesRead: 9 });
    const got = rows(h);
    expect(got).toHaveLength(6);
    expect(got.every((r) => r.generation === 1)).toBe(true);
    expect(got.find((r) => r.part === 'C')?.state).toBe('COMPLETED');
    expect(h.store.getSource(pathKey(h.logFile))?.configSha256).toBe(configHash(attemptsSettings(h.context().config)!));
  });

  it('reads an invalid-format time as no match, never as a failure of the tick', async () => {
    const h = harness({ timeFormat: '%d/%m/%Y' });
    h.writeLog(`${startLine(BASE_MS, 'A')}\n`);
    await expect(tick(h)).resolves.toMatchObject({ result: { state: 'ok', rowsChanged: 0 } });
    expect(rows(h)).toEqual([]);
  });
});

describe('matching inside the tick', () => {
  it('matches a run to the session of its part in the same transaction', async () => {
    const h = harness();
    const session = h.addSession(uid(1), { label: 'step C', firstMs: BASE_MS + 2500 });
    h.writeLog(sixParts());
    const { result } = await tick(h);
    expect(result.rowsChanged).toBe(6 + 2 + 1);
    expect(rows(h).find((r) => r.part === 'C')).toMatchObject({ sessionRowId: session, matchDeltaMs: 500 });
    expect(rows(h).filter((r) => r.sessionRowId !== null)).toHaveLength(1);
  });

  it('matches a run later, when its session appears, and keeps the match for good', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    const session = h.addSession(uid(1), { label: 'step D', firstMs: BASE_MS + 3000 });
    h.clock.advance(2000);
    const { result } = await tick(h, state);
    expect(result).toMatchObject({ linesRead: 0, rowsChanged: 1 });
    expect(rows(h).find((r) => r.part === 'D')?.sessionRowId).toBe(session);
    // a second, better session does not take the run away
    h.addSession(uid(2), { label: 'step D', firstMs: BASE_MS + 3000 });
    h.clock.advance(2000);
    await tick(h, state);
    expect(rows(h).find((r) => r.part === 'D')?.sessionRowId).toBe(session);
  });

  it('does not match a session whose first record is outside the window', async () => {
    const h = harness();
    h.addSession(uid(1), { label: 'step C', firstMs: BASE_MS + 2000 + 601_000 });
    h.writeLog(sixParts());
    await tick(h);
    expect(rows(h).filter((r) => r.sessionRowId !== null)).toEqual([]);
  });
});

describe('a log that is hostile or very large', () => {
  it('takes a bounded slice per tick and reads a log of 100,000 lines to the end', async () => {
    const h = harness();
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i += 1) {
      const part = String.fromCharCode(65 + (i % 26));
      const at = BASE_MS + Math.floor(i / 20) * 1000;
      lines.push(startLine(at, part, i), endLine(at, part, 0, 'PASS'));
    }
    h.writeLog(`${lines.join('\n')}\n`);
    const size = statSync(h.logFile).size;
    expect(size).toBeGreaterThan(5_000_000);
    const state = createAttemptsState();
    const { sliceBytes } = ATTEMPTS_LIMITS;
    let total = 0;
    let ticks = 0;
    let slowest = 0;
    let previousOffset = 0;
    for (;;) {
      const t0 = performance.now();
      const { result } = await tick(h, state);
      slowest = Math.max(slowest, performance.now() - t0);
      ticks += 1;
      total += result.linesRead;
      const offset = h.store.getSource(pathKey(h.logFile))?.readOffset ?? 0;
      // one slice: the bytes of a tick stay near the limit (the limit plus the line that crosses it)
      expect(offset - previousOffset).toBeLessThanOrEqual(sliceBytes + 200);
      previousOffset = offset;
      h.clock.advance(2000);
      if (offset >= size) break;
      expect(ticks).toBeLessThan(200);
    }
    expect(total).toBe(100_000);
    expect(h.committedRuns()).toBe(50_000);
    expect(ticks).toBeGreaterThan(20);
    // a generous bound, scaled like the other performance assertions (05 4.6): one slice never blocks the loop for long
    expect(slowest).toBeLessThan(1500 * PERF_FACTOR);
  }, 120_000);

  it('stops a slice at its deadline and still takes at least one line per tick', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    const counts: number[] = [];
    for (let i = 0; i < 12 && (counts.at(-1) ?? 1) > 0; i += 1) {
      counts.push((await tick(h, state, { sliceDeadlineMs: 0 })).result.linesRead);
      h.clock.advance(2000);
    }
    expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0]);
    expect(rows(h)).toHaveLength(6);
  });

  it('looks at no more than the range of a tick from the stored offset', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const first = startLine(BASE_MS, 'A').length + 1;
    const { result } = await tick(h, createAttemptsState(), { rangeBytes: first + 10 });
    expect(result.linesRead).toBe(1);
    expect(h.store.getSource(pathKey(h.logFile))?.readOffset).toBe(first);
  });

  it('skips a line of more than a megabyte and goes on with the next one', async () => {
    const h = harness();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${'x'.repeat(1_200_000)}\n${startLine(BASE_MS + 1000, 'B')}\n`);
    // the skipped line is more than one slice: the line after it is read by the next tick
    const state = createAttemptsState();
    await tick(h, state);
    await tick(h, state);
    expect(rows(h).map((r) => r.part)).toEqual(['A', 'B']);
  });

  it('does not read the middle of a huge line, still being written, as a line of its own', async () => {
    const h = harness();
    h.writeLog(`${startLine(BASE_MS, 'A')}\n${'x'.repeat(1_200_000)}`);
    const state = createAttemptsState();
    await tick(h, state);
    expect(rows(h).map((r) => r.part)).toEqual(['A']);
    // the writer goes on with the same line: what follows would be a valid START if it stood at the start of a line
    h.appendLog(`${startLine(BASE_MS + 1000, 'B')}\n${startLine(BASE_MS + 2000, 'C')}\n`);
    h.clock.advance(2000);
    await tick(h, state);
    expect(rows(h).map((r) => r.part)).toEqual(['A', 'C']);
  });

  it('cuts a line at 10,000 pieces and goes on', async () => {
    const h = harness();
    h.writeLog(
      `${startLine(BASE_MS, 'A')}${'\r'.repeat(50_000)}${startLine(BASE_MS + 1000, 'B')}\n${startLine(BASE_MS + 2000, 'C')}\n`,
    );
    await tick(h);
    expect(rows(h).map((r) => r.part)).toEqual(['A', 'C']);
  });
});

describe('the panel read (06 3.10.8)', () => {
  const USAGE: TokenUsage = {
    input: 10,
    output: 20,
    cacheCreation: 0,
    cacheRead: 5,
    total: 35,
    missing: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    turns: 3,
    synthetic: 0,
    unfinalized: 0,
    completeness: 'complete',
    scannedPct: 100,
    lowerBound: false,
  };

  function panelContext(h: AttemptsHarness, summaries: { id: string }[] = []) {
    const base = h.context();
    return {
      db: h.db,
      scope: SCOPE,
      config: base.config,
      queries: {
        sessionSummaries: (_scope: unknown, ids: readonly number[]) => {
          expect(ids.length).toBeGreaterThan(0);
          return summaries.map((s) => ({ id: s.id, usageInclSubagents: USAGE }));
        },
      } as never,
    };
  }

  it('maps the newest rows in start order, with the session id, the usage and the exact texts', async () => {
    const h = harness();
    h.addSession(uid(1), { label: 'step C', firstMs: BASE_MS + 2500 });
    h.writeLog(sixParts());
    await tick(h);
    const panel = readAttemptsPanel(panelContext(h, [{ id: uid(1) }]), 4);
    expect(AttemptsPanelSchema.safeParse(panel).success).toBe(true);
    expect(panel.sourceState).toBe('ok');
    expect(panel.rows.map((r) => r.part)).toEqual(['C', 'D', 'E', 'F']);
    expect(panel.rows[0]).toMatchObject({
      n: 3,
      nRaw: '3',
      model: 'haiku',
      effort: 'low',
      startedAt: new Date(BASE_MS + 2000).toISOString(),
      endedAt: null,
      exit: null,
      exitRaw: null,
      status: null,
      state: 'RUNNING',
      sessionId: uid(1),
      usage: USAGE,
      endReason: 'open',
      evidence: 'chain log: started, no END yet',
      matchDeltaS: 0.5,
    });
    expect(panel.rows[1]).toMatchObject({ sessionId: null, usage: null, matchDeltaS: null });
  });

  it('reads exit and n as numbers only when they are whole numbers', async () => {
    const h = harness({
      start: String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) START attempt (?<n>\S+)`,
      end: String.raw`^(?<time>\S+ \S+) STEP (?<part>[A-Z]) END exit=(?<exit>\S+) status=(?<status>\S+)`,
    });
    h.writeLog(
      [
        `${logTime(BASE_MS)} STEP A START attempt 007`,
        `${logTime(BASE_MS + 1000)} STEP A END exit=-3 status=FAIL`,
        `${logTime(BASE_MS + 2000)} STEP B START attempt x1`,
        `${logTime(BASE_MS + 3000)} STEP B END exit=1.5 status=FAIL`,
        `${logTime(BASE_MS + 4000)} STEP C START attempt ${'9'.repeat(30)}`,
        '',
      ].join('\n'),
    );
    await tick(h);
    const panel = readAttemptsPanel(panelContext(h), 10);
    expect(panel.rows.map((r) => [r.part, r.n, r.nRaw, r.exit, r.exitRaw])).toEqual([
      ['A', 7, '007', -3, '-3'],
      ['B', null, 'x1', null, '1.5'],
      ['C', null, '9'.repeat(30), null, null],
    ]);
    expect(AttemptsPanelSchema.safeParse(panel).success).toBe(true);
  });

  it('includes the rows of older generations and reports the source state it is given', async () => {
    const h = harness();
    h.writeLog(sixParts());
    const state = createAttemptsState();
    await tick(h, state);
    h.writeLog(`${startLine(BASE_MS + 10 * MINUTE, 'G', 7)}\n`);
    await tick(h, state);
    const panel = readAttemptsPanel(panelContext(h), 50, 'missing');
    expect(panel.rows).toHaveLength(7);
    expect(panel.sourceState).toBe('missing');
  });

  it('says not_configured without attempts or chain_log, and ok otherwise', () => {
    const h = harness();
    const context = panelContext(h);
    expect(readAttemptsPanel(context, 5)).toEqual({ rows: [], sourceState: 'ok' });
    const unset = { ...context, config: { monitor: { ...context.config.monitor, attempts: null } } };
    expect(readAttemptsPanel(unset, 5)).toEqual({ rows: [], sourceState: 'not_configured' });
  });
});
