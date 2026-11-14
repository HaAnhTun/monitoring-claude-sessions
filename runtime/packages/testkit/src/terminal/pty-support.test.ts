import { describe, expect, it, vi } from 'vitest';

import {
  PTY_SKIP_REASON_OFF_WINDOWS,
  describePtyTests,
  ptySupport,
  scaled,
  type PtySupportDeps,
  type PtySupportResult,
} from './pty-support.ts';

const GOOD: PtySupportDeps = {
  platform: 'win32',
  arch: 'x64',
  probeAddon: () => null,
  fakeClaudeExists: () => true,
};

describe('scaled', () => {
  it('multiplies by QA_TIME_SCALE and defaults to 1', () => {
    expect(scaled(1000, {})).toBe(1000);
    expect(scaled(1000, { QA_TIME_SCALE: '2' })).toBe(2000);
    expect(scaled(20_000, { QA_TIME_SCALE: '3' })).toBe(60_000);
  });

  it('clamps the factor to 1..5', () => {
    expect(scaled(1000, { QA_TIME_SCALE: '0' })).toBe(1000);
    expect(scaled(1000, { QA_TIME_SCALE: '-4' })).toBe(1000);
    expect(scaled(1000, { QA_TIME_SCALE: '5' })).toBe(5000);
    expect(scaled(1000, { QA_TIME_SCALE: '50' })).toBe(5000);
  });

  it('ignores a value that is not a number and keeps fractions', () => {
    expect(scaled(1000, { QA_TIME_SCALE: 'fast' })).toBe(1000);
    expect(scaled(1000, { QA_TIME_SCALE: '' })).toBe(1000);
    expect(scaled(1000, { QA_TIME_SCALE: 'Infinity' })).toBe(1000);
    expect(scaled(1000, { QA_TIME_SCALE: '2.5' })).toBe(2500);
    expect(scaled(3, { QA_TIME_SCALE: '1.5' })).toBe(5);
  });

  it('reads the environment of the process by default', () => {
    vi.stubEnv('QA_TIME_SCALE', '4');
    try {
      expect(scaled(10)).toBe(40);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

function reasonOf(result: PtySupportResult): string {
  return result.ok ? '' : result.reason;
}

describe('ptySupport', () => {
  it('is ok on Windows x64 and arm64 when the addon loads and the fake claude exists', () => {
    expect(ptySupport(GOOD)).toEqual({ ok: true });
    expect(ptySupport({ ...GOOD, arch: 'arm64' })).toEqual({ ok: true });
  });

  it('is not ok off Windows, with the reason of the release', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const result = ptySupport({ ...GOOD, platform });
      expect(result).toEqual({ ok: false, reason: PTY_SKIP_REASON_OFF_WINDOWS });
    }
    expect(PTY_SKIP_REASON_OFF_WINDOWS).toBe('terminals are Windows-only in this release');
  });

  it('is not ok on a Windows architecture without a native build', () => {
    const result = ptySupport({ ...GOOD, arch: 'ia32' });
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/ia32/);
  });

  it('is not ok when the addon does not load, and keeps the probe reason', () => {
    const result = ptySupport({ ...GOOD, probeAddon: () => 'the terminal addon does not load (MODULE_NOT_FOUND)' });
    expect(result).toEqual({ ok: false, reason: 'the terminal addon does not load (MODULE_NOT_FOUND)' });
  });

  it('is not ok when the fake claude script is missing', () => {
    const result = ptySupport({ ...GOOD, fakeClaudeExists: () => false });
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toMatch(/fake claude/);
  });

  it('does not probe the addon off Windows', () => {
    const probeAddon = vi.fn(() => null);
    ptySupport({ ...GOOD, platform: 'linux', probeAddon });
    expect(probeAddon).not.toHaveBeenCalled();
  });

  it('catches a probe that throws and reports it as not ok without the message', () => {
    const result = ptySupport({
      ...GOOD,
      probeAddon: () => {
        throw new Error('C:\\private\\path failed');
      },
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private/);
  });
});

interface Declared {
  title: string;
  skip: boolean;
  body: () => void;
}

function capture(): { declared: Declared[]; declare: (title: string, body: () => void, skip: boolean) => void } {
  const declared: Declared[] = [];
  return {
    declared,
    declare: (title, body, skip) => {
      declared.push({ title, skip, body });
    },
  };
}

describe('describePtyTests', () => {
  const body = (): void => undefined;

  it('declares a normal suite when the support is ok', () => {
    const { declared, declare } = capture();
    describePtyTests('TC-PTY-00 real terminal', body, { ...GOOD, env: { QA_PTY_REQUIRED: '1' }, declare });
    expect(declared).toEqual([{ title: 'TC-PTY-00 real terminal', skip: false, body }]);
  });

  it('skips off Windows with the reason in the title, even when QA_PTY_REQUIRED=1', () => {
    for (const env of [{}, { QA_PTY_REQUIRED: '1' }]) {
      const { declared, declare } = capture();
      describePtyTests('TC-PTY-00 real terminal', body, { ...GOOD, platform: 'linux', env, declare });
      expect(declared).toEqual([
        {
          title: 'TC-PTY-00 real terminal [skipped on linux: terminals are Windows-only in this release]',
          skip: true,
          body,
        },
      ]);
    }
  });

  it('skips on Windows with a stated reason when the support is broken and nothing is required', () => {
    const { declared, declare } = capture();
    describePtyTests('TC-PTY-00 real terminal', body, {
      ...GOOD,
      probeAddon: () => 'the terminal addon does not load',
      env: {},
      declare,
    });
    expect(declared).toHaveLength(1);
    expect(declared[0]?.skip).toBe(true);
    expect(declared[0]?.title).toBe('TC-PTY-00 real terminal [skipped on win32: the terminal addon does not load]');
  });

  it('THROWS on Windows when QA_PTY_REQUIRED=1 and the addon probe fails', () => {
    const { declared, declare } = capture();
    expect(() => {
      describePtyTests('TC-PTY-00 real terminal', body, {
        ...GOOD,
        probeAddon: () => 'the terminal addon does not load',
        env: { QA_PTY_REQUIRED: '1' },
        declare,
      });
    }).toThrow(/QA_PTY_REQUIRED.*the terminal addon does not load/s);
    expect(declared).toEqual([]);
  });

  it('THROWS on Windows when QA_PTY_REQUIRED=1 and the fake claude is missing', () => {
    const { declare } = capture();
    expect(() => {
      describePtyTests('TC-PTY-00 real terminal', body, {
        ...GOOD,
        fakeClaudeExists: () => false,
        env: { QA_PTY_REQUIRED: '1' },
        declare,
      });
    }).toThrow(/fake claude/);
  });

  it('names the suite in the error', () => {
    const { declare } = capture();
    expect(() => {
      describePtyTests('TC-PTY-77 named suite', body, {
        ...GOOD,
        probeAddon: () => 'broken',
        env: { QA_PTY_REQUIRED: '1' },
        declare,
      });
    }).toThrow(/TC-PTY-77 named suite/);
  });

  it('only the value 1 makes the support required', () => {
    for (const value of ['', '0', 'true', 'yes']) {
      const { declared, declare } = capture();
      describePtyTests('TC-PTY-00 real terminal', body, {
        ...GOOD,
        probeAddon: () => 'broken',
        env: { QA_PTY_REQUIRED: value },
        declare,
      });
      expect(declared[0]?.skip, value).toBe(true);
    }
  });
});

// The default declare really skips: this body must never run.
describePtyTests(
  'TC-GATE-00 a suite off Windows is skipped by the default declare',
  () => {
    it('is never run', () => {
      throw new Error('this body must be skipped');
    });
  },
  { ...GOOD, platform: 'linux', env: {} },
);
