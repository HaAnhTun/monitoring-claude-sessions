import { describe, expect, it } from 'vitest';

import config from '../../vitest.config.ts';

const REQUIRED_PROJECTS = ['unit', 'integration', 'isolation', 'resilience', 'parity', 'tooling'];

describe('root vitest config', () => {
  it('declares the inline projects of 05 section 2.8', () => {
    const projects = config.test?.projects ?? [];
    const names = projects.flatMap((project) =>
      typeof project === 'object' && 'test' in project ? [project.test.name] : [],
    );
    expect(names).toEqual(expect.arrayContaining(REQUIRED_PROJECTS));
  });

  it('resolves workspace sources through the @mcs/source condition', () => {
    expect(config.ssr?.resolve?.conditions).toContain('@mcs/source');
  });
});
