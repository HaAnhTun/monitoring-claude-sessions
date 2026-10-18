import { describe, expect, it } from 'vitest';

import config from '../../vitest.config.ts';

const REQUIRED_PROJECTS = ['unit', 'integration', 'isolation', 'resilience', 'slow', 'tooling'];

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

  it('resolves workspace sources through the @mcs/source condition', () => {
    expect(config.ssr?.resolve?.conditions).toContain('@mcs/source');
  });
});
