// Output integrity through a real pseudo console (CAW-55; design 08 section 3.4, ids TC-PTY-07, TC-PTY-09 and TC-PTY-13): the last
// words of a process that exits at once, a burst that a fast consumer must receive line for line, and multi-byte characters that
// are written one byte at a time. The fake claude supplies the oracles: `/last-words`, `/burst` (with its own checksum) and `/utf8`.
// Windows only; a missing addon FAILS the run.
import { UTF8_UNIT, burstExpected, describePtyTests, waitFor } from '@mcs/testkit';
import { expect, it } from 'vitest';

import { PER_TEST_TIMEOUT_MS, exitWaitMs, readBurst, useRealHarnesses, type RealSession } from './real-harness.ts';

const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd);

/** The last bytes of a recording, as text: the cheap way to see that a long run has finished. */
function tail(bytes: Buffer): string {
  return bytes.subarray(Math.max(0, bytes.length - 256)).toString('latin1');
}

async function waitForBurstEnd(session: RealSession): Promise<void> {
  await waitFor(() => /BURST-DONE:\d+:[0-9a-f]{8}\r?\n/.test(tail(session.output.raw())), {
    timeoutMs: exitWaitMs(),
    intervalMs: 200,
    what: 'the end of the burst',
  });
}

describePtyTests('pty output integrity', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-07 /last-words: the final output of a process that exits in the same tick arrives before the exit, 20 times',
    async () => {
      const h = start({ route: 'direct' });
      const rounds = 20;
      const batch = 3;
      const failures: string[] = [];
      for (let from = 0; from < rounds; from += batch) {
        // At most three live sessions at a time.
        const sessions: RealSession[] = [];
        for (let i = from; i < Math.min(from + batch, rounds); i += 1) sessions.push(await h.open());
        for (const s of sessions) s.line('/last-words');
        const exits = await Promise.all(sessions.map((s) => s.waitEnd()));
        sessions.forEach((s, i) => {
          const round = from + i + 1;
          const exit = exits[i];
          if (exit?.code !== 0 || exit.reason !== 'exited')
            failures.push(`round ${String(round)}: ended with ${JSON.stringify(exit)}`);
          // The text the viewer had when it was told that the session ended: the words must be in it.
          if (!/LAST-WORDS:1(?!\d)/.test(s.endedView()?.text ?? ''))
            failures.push(`round ${String(round)}: the last words had not arrived when the session ended`);
        });
      }
      expect(failures).toEqual([]);
      expect(h.service.liveCount()).toBe(0);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-09 /burst 3072 with a fast consumer: every line arrives once and in order, and the checksums agree',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      s.line('/burst 3072');
      await waitForBurstEnd(s);
      const expected = burstExpected(3072);
      const reading = readBurst(s.output.text());
      expect(reading.seqs.length).toBe(expected.lines);
      expect(reading.seqs[0]).toBe(0);
      expect(reading.seqs[reading.seqs.length - 1]).toBe(expected.lines - 1);
      expect(reading.breaks).toBe(0);
      // The fake's checksum (over what it wrote), the oracle of the protocol and the one over what arrived are the same number.
      expect(reading.done).toEqual({ lines: expected.lines, checksum: expected.checksum });
      expect(reading.checksum).toBe(expected.checksum);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-09 /burst of 12-byte lines (the most lines for the bytes): none is lost, repeated or joined',
    async () => {
      const h = start({ route: 'direct' });
      const s = await h.open();
      s.line('/burst 256 12');
      await waitForBurstEnd(s);
      const expected = burstExpected(256, 12);
      expect(expected.lines).toBe(21_845);
      const reading = readBurst(s.output.text());
      expect(reading.seqs.length).toBe(expected.lines);
      expect(reading.breaks).toBe(0);
      expect(reading.done).toEqual({ lines: expected.lines, checksum: expected.checksum });
      expect(reading.checksum).toBe(expected.checksum);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-09 two sessions that burst at the same time each get their own lines, with no crosstalk',
    async () => {
      const h = start({ route: 'direct' });
      const a = await h.open();
      const b = await h.open();
      a.line('/burst 1024');
      b.line('/burst 1024 120');
      await Promise.all([waitForBurstEnd(a), waitForBurstEnd(b)]);
      for (const [s, lineBytes] of [
        [a, 100],
        [b, 120],
      ] as const) {
        const expected = burstExpected(1024, lineBytes);
        const reading = readBurst(s.output.text());
        expect(reading.seqs.length).toBe(expected.lines);
        expect(reading.breaks).toBe(0);
        expect(reading.done).toEqual({ lines: expected.lines, checksum: expected.checksum });
        expect(reading.checksum).toBe(expected.checksum);
      }
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-13 /utf8 1000 writes every byte separately: 1000 whole characters of each width arrive, live and in the replay',
    async () => {
      const h = start({ route: 'direct' });
      // 5000 cells of text: a terminal tall enough that the screen never scrolls. When it scrolls, ConPTY repaints and repeats the last
      // wide glyph of some rows (measured: 15 repeats at 120x30, none at 120x60); that is the console host, not the pipeline.
      const s = await h.open({ cols: 200, rows: 100 });
      s.line('/utf8 1000');
      await s.waitText('UTF8-DONE:1000');

      // The console wraps lines and may put a break next to a wide character; the characters themselves must be whole and in order.
      const compact = (text: string): string => text.replace(/\s/g, '');
      const wanted = UTF8_UNIT.repeat(1000);
      const live = s.output.text();
      expect(live).not.toContain(REPLACEMENT_CHARACTER);
      expect(compact(live)).toContain(wanted);

      const late = s.attachViewer();
      const replay = late.output.text();
      expect(replay).not.toContain(REPLACEMENT_CHARACTER);
      expect(compact(replay)).toContain(wanted);
      await h.close();
    },
    PER_TEST_TIMEOUT_MS,
  );
});
