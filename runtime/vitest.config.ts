import { defineConfig } from 'vitest/config';

const SOURCE_CONDITION = '@mcs/source';

export default defineConfig({
  // Only the custom condition: Vitest turns this list into `node --conditions ...` flags for its workers, and an `import`
  // flag makes require() of a dual package (is-promise under Express 5) return the ES module namespace (CR-WP-08-1).
  // Vite keeps its own default conditions for transforms.
  ssr: { resolve: { conditions: [SOURCE_CONDITION] } },
  test: {
    // Determinism defaults for every project (05-tooling-testing-security.md section 3.6).
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    testTimeout: 10_000,
    hookTimeout: 20_000,
    env: { TZ: 'UTC', MCS_HOOK_DISABLE: '1' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/{shared,engine,server,cli,testkit}/src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          pool: 'forks',
          include: ['packages/*/test/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'isolation', environment: 'node', pool: 'forks', include: ['tests/isolation/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'resilience', environment: 'node', pool: 'forks', include: ['tests/resilience/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'parity',
          environment: 'node',
          pool: 'forks',
          include: ['tests/parity/**/*.test.ts'],
          // @wp-begin WP-43
          // @wp-end WP-43
        },
      },
      {
        extends: true,
        test: { name: 'tooling', environment: 'node', pool: 'forks', include: ['tests/tooling/**/*.test.ts'] },
      },
      './packages/web/vitest.config.ts',
      // @wp-begin WP-72
      // @wp-end WP-72
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', 'packages/testkit/**', '**/main.ts', '**/main.tsx', '**/hook.ts', '**/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
        'packages/engine/src/{lifecycle,ingest,tokens,config}/**': {
          lines: 90,
          statements: 90,
          functions: 90,
          branches: 85,
        },
        'packages/shared/src/**': { lines: 90, statements: 90, functions: 90, branches: 85 },
      },
    },
  },
});
