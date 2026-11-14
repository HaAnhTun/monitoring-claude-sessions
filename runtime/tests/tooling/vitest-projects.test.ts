import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../../vitest.config.ts';

const REQUIRED_PROJECTS = ['unit', 'integration', 'isolation', 'resilience', 'slow', 'tooling', 'pty'];

describe('root vitest config', () => {
  it('declares the inline projects of 05 section 2.8', () => {
    const projects = config.test?.projects ?? [];
    const names = projects.flatMap((project) =>
      typeof project === 'object' && 'test' in project ? [project.test.name] : [],
    );
    expect(names).toEqual(expect.arrayContaining(REQUIRED_PROJECTS));
  });

  it('has the slow project for the heavy data-driven suites, and no parity project (ADR 0066)', () => {
    const projects = config.test?.projects ?? [];
    const inline = projects.flatMap((project) =>
      typeof project === 'object' && 'test' in project ? [project.test] : [],
    );
    expect(inline.map((test) => test.name)).not.toContain('parity');
    const slow = inline.find((test) => test.name === 'slow');
    expect(slow?.include).toEqual(['packages/*/test/**/*.slow.test.ts']);
  });

  // TC-GATE-01: the real-terminal project (design 08 section 4.1). One file at a time is the load-bearing option: each file starts
  // consoles and child processes on a shared machine. It has its own gate (`npm run test:pty`) and is not part of `npm test`.
  it('TC-GATE-01 has the pty project: forks, one file at a time, 30 s timeouts, the *.pty.test.ts glob', () => {
    const projects = config.test?.projects ?? [];
    const inline = projects.flatMap((project) =>
      typeof project === 'object' && 'test' in project ? [project.test] : [],
    );
    const pty = inline.find((test) => test.name === 'pty');
    expect(pty).toBeDefined();
    expect(pty?.environment).toBe('node');
    expect(pty?.pool).toBe('forks');
    expect(pty?.fileParallelism).toBe(false);
    expect(pty?.testTimeout).toBe(30_000);
    expect(pty?.hookTimeout).toBe(30_000);
    expect(pty?.include).toEqual(['packages/*/test/**/*.pty.test.ts']);
  });

  it('TC-GATE-01 keeps the pty files out of every other project and the pty project out of npm test', () => {
    const projects = config.test?.projects ?? [];
    const inline = projects.flatMap((project) =>
      typeof project === 'object' && 'test' in project ? [project.test] : [],
    );
    for (const test of inline.filter((t) => t.name !== 'pty')) {
      for (const pattern of test.include ?? []) {
        expect(pattern.endsWith('.pty.test.ts')).toBe(false);
        expect(pattern).not.toBe('packages/*/test/**/*.test.ts');
      }
    }
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['test']).not.toContain('pty');
  });

  it('resolves workspace sources through the @mcs/source condition', () => {
    expect(config.ssr?.resolve?.conditions).toContain('@mcs/source');
  });
});
