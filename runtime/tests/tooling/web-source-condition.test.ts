// The web project must resolve workspace packages to their sources in every environment (ADR 0040: tests need no prior build).
// Suites that start with `// @vitest-environment node` (url-state, lifecycle-display) are resolved through the SSR conditions, so
// `ssr.resolve.conditions` carries the custom condition, and only it (CR-WP-08-1: an `import` flag reaches the node workers).
import { describe, expect, it } from 'vitest';

import viteConfig from '../../packages/web/vite.config.ts';
import vitestWebConfig from '../../packages/web/vitest.config.ts';

const ENV = { command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false } as const;

describe('packages/web resolve conditions', () => {
  it('the vite config resolves @mcs/source for the client and for SSR (node-environment suites)', () => {
    const resolved = viteConfig(ENV);
    expect(resolved.resolve?.conditions).toContain('@mcs/source');
    expect(resolved.ssr?.resolve?.conditions).toEqual(['@mcs/source']);
  });

  it('the web test project keeps both condition lists', () => {
    const resolved = vitestWebConfig(ENV);
    expect(resolved.resolve?.conditions).toContain('@mcs/source');
    expect(resolved.ssr?.resolve?.conditions).toEqual(['@mcs/source']);
  });
});
