import { describe, expect, it, vi } from 'vitest';

import { TerminalOutput, stripAnsi } from './output.ts';

const ESC = '\x1b';
const BEL = '\x07';

describe('stripAnsi', () => {
  it('removes CSI sequences: colours, cursor moves, erase, modes, private modes and intermediates', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain');
    expect(stripAnsi(`a${ESC}[2K${ESC}[1;1Hb${ESC}[10A${ESC}[?25l${ESC}[?2004hc${ESC}[38;2;1;2;3md`)).toBe('abcd');
    expect(stripAnsi(`${ESC}[ qx${ESC}[>0cy${ESC}[!pz`)).toBe('xyz');
    expect(stripAnsi(`${ESC}[mq`)).toBe('q');
  });

  it('removes OSC sequences ended by BEL or by ST (ESC backslash)', () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}text`)).toBe('text');
    expect(stripAnsi(`${ESC}]8;;https://example.invalid${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
    expect(stripAnsi(`${ESC}]633;A${BEL}${ESC}]633;B${BEL}> `)).toBe('> ');
  });

  it('removes an OSC that is cut off at the end of the input', () => {
    expect(stripAnsi(`kept${ESC}]0;half a title`)).toBe('kept');
  });

  it('removes DCS, PM and APC strings', () => {
    expect(stripAnsi(`${ESC}P1$r0m${ESC}\\x${ESC}_apc data${ESC}\\y${ESC}^pm${ESC}\\z`)).toBe('xyz');
  });

  it('removes charset selects, keypad modes, cursor save and restore, and single-character escapes', () => {
    expect(stripAnsi(`${ESC}(Bx${ESC})0y${ESC}*Az${ESC}+B`)).toBe('xyz');
    expect(stripAnsi(`${ESC}=a${ESC}>b${ESC}7c${ESC}8d${ESC}Me${ESC}Df${ESC}Eg${ESC}ch`)).toBe('abcdefgh');
    expect(stripAnsi(`${ESC}#8x${ESC} Fy`)).toBe('xy');
  });

  it('keeps text, tabs, newlines, carriage returns and BEL outside a sequence', () => {
    expect(stripAnsi('a\tb\r\nc')).toBe('a\tb\r\nc');
    expect(stripAnsi(`ding${BEL}`)).toBe(`ding${BEL}`);
  });

  it('keeps non-ASCII text', () => {
    expect(stripAnsi(`${ESC}[1m\u00e9\u4e2d\u{1f600}${ESC}[0m`)).toBe('\u00e9\u4e2d\u{1f600}');
  });

  it('decodes bytes as UTF-8', () => {
    expect(stripAnsi(Buffer.from(`${ESC}[32m\u00e9${ESC}[0m`))).toBe('\u00e9');
    expect(stripAnsi(Uint8Array.from([0x61, 0x62]))).toBe('ab');
  });

  it('removes the 8-bit CSI introducer too', () => {
    expect(stripAnsi('a\u009b31mb')).toBe('ab');
  });
});

describe('TerminalOutput', () => {
  it('records raw bytes and the stripped text', () => {
    const out = new TerminalOutput();
    out.push(`${ESC}[1mhello${ESC}[0m `);
    out.push(Buffer.from('world'));
    expect(out.raw().toString()).toBe(`${ESC}[1mhello${ESC}[0m world`);
    expect(out.text()).toBe('hello world');
  });

  it('decodes UTF-8 characters that are split across chunks', () => {
    const out = new TerminalOutput();
    const bytes = Buffer.from('a\u00e9\u4e2d\u{1f600}z');
    for (const byte of bytes) out.push(Uint8Array.from([byte]));
    expect(out.text()).toBe('a\u00e9\u4e2d\u{1f600}z');
    expect(out.text()).not.toContain('\ufffd');
  });

  it('strips an escape sequence that is split across chunks', () => {
    const out = new TerminalOutput();
    out.push(`x${ESC}[3`);
    out.push('1my');
    out.push(`${ESC}]0;ti`);
    out.push(`tle${BEL}z`);
    expect(out.text()).toBe('xyz');
  });

  it('count() counts non-overlapping occurrences in the text', () => {
    const out = new TerminalOutput();
    out.push(`ab${ESC}[0mab ab`);
    expect(out.count('ab')).toBe(3);
    expect(out.count('aa')).toBe(0);
    out.push('aaaa');
    expect(out.count('aa')).toBe(2);
    expect(() => out.count('')).toThrow(RangeError);
  });

  it('clear() forgets everything', () => {
    const out = new TerminalOutput();
    out.push('abc');
    out.clear();
    expect(out.raw()).toHaveLength(0);
    expect(out.text()).toBe('');
    out.push('d');
    expect(out.text()).toBe('d');
  });

  it('until() resolves at once when the text already holds a string, and returns it', async () => {
    const out = new TerminalOutput();
    out.push('READY pid=1');
    await expect(out.until('READY')).resolves.toBe('READY');
  });

  it('until() resolves with the match of a regular expression', async () => {
    const out = new TerminalOutput();
    out.push('size 120x30');
    const match = await out.until(/size (\d+)x(\d+)/);
    expect(match).not.toBeTypeOf('string');
    expect(Array.from(match as RegExpMatchArray)).toEqual(['size 120x30', '120', '30']);
  });

  it('until() waits for later chunks and sees text across a chunk boundary', async () => {
    const out = new TerminalOutput();
    const waiting = out.until('prompt> ');
    out.push('prom');
    out.push(`${ESC}[0mpt`);
    out.push('> ');
    await expect(waiting).resolves.toBe('prompt> ');
  });

  it('until() can wait for the same text more than once after clear()', async () => {
    const out = new TerminalOutput();
    out.push('ok');
    await out.until('ok');
    out.clear();
    const again = out.until('ok');
    out.push('ok');
    await again;
  });

  it('until() rejects on its timeout and names the count of characters, not the content', async () => {
    const out = new TerminalOutput();
    out.push('FIXTURE-secret-text');
    const failure = await out.until('never', { timeoutMs: 30 }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/timed out after 30 ms/);
    expect(failure?.message).toMatch(/never/);
    expect(failure?.message).toMatch(/19 characters/);
    expect(failure?.message).not.toMatch(/secret/);
  });

  it('until() uses 20 s scaled by QA_TIME_SCALE when no timeout is given', async () => {
    vi.useFakeTimers();
    vi.stubEnv('QA_TIME_SCALE', '2');
    try {
      const out = new TerminalOutput();
      let failure: string | null = null;
      out.until('x').catch((error: unknown) => {
        failure = (error as Error).message;
      });
      await vi.advanceTimersByTimeAsync(39_999);
      expect(failure).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toMatch(/timed out after 40000 ms/);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('every waiter is settled: two until() calls resolve on one push', async () => {
    const out = new TerminalOutput();
    const a = out.until('a');
    const b = out.until(/b/);
    out.push('ab');
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });
});
