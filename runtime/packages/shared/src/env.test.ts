/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DOCUMENTED_ENV_VARS } from './env.ts';

/** The complete list of 01 section 2.10, in the order of that section. */
const EXPECTED: readonly (readonly [string, 'runtime' | 'test' | 'dev'])[] = [
  ['MCS_LOG_LEVEL', 'runtime'],
  ['MCS_HOOK_DISABLE', 'runtime'],
  ['MCS_HOME', 'runtime'],
  ['CLAUDE_CONFIG_DIR', 'runtime'],
  ['MCS_FS_WATCH', 'runtime'],
  ['MCS_LAUNCHER_NO_BOOTSTRAP', 'runtime'],
  ['MCS_PYTHON', 'runtime'],
  ['MCS_DEBUG', 'runtime'],
  ['MCS_TEST', 'test'],
  ['MCS_TEST_IGNORE_CONTROL', 'test'],
  ['MCS_TEST_BOOT_HANG', 'test'],
  ['MCS_TEST_INIT_CRASH', 'test'],
  ['MCS_PERF_FACTOR', 'test'],
  ['MCS_GOLDEN_LIVE_CONFIG', 'test'],
  ['MCS_GOLDEN_DIR', 'test'],
  ['MCS_PARITY_LIVE', 'test'],
  ['MCS_E2E_CLAUDE', 'test'],
  ['MCS_DEV_API', 'dev'],
  ['MCS_WEB_DEV_PORT', 'dev'],
  ['MCS_WEB_PREVIEW_PORT', 'dev'],
  ['MCS_BUILD_ID', 'dev'],
];

describe('DOCUMENTED_ENV_VARS', () => {
  it('lists exactly the variables of 01 section 2.10 with their scope', () => {
    expect(DOCUMENTED_ENV_VARS.map((v) => [v.name, v.scope])).toEqual(EXPECTED);
  });

  it('has unique names that look like environment variables', () => {
    const names = DOCUMENTED_ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name, name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('does not contain MCS_E2E_PORT (I-27, N-02)', () => {
    expect(DOCUMENTED_ENV_VARS.some((v) => v.name === 'MCS_E2E_PORT')).toBe(false);
  });

  it('gives every variable at least one reader file, relative to the skill root, with forward slashes', () => {
    for (const v of DOCUMENTED_ENV_VARS) {
      expect(v.readers.length, v.name).toBeGreaterThan(0);
      for (const file of v.readers) {
        expect(file, `${v.name}: ${file}`).toMatch(/^[A-Za-z0-9_.@/-]+$/);
        expect(file.startsWith('/') || file.includes('..') || file.includes('\\'), file).toBe(false);
      }
    }
  });

  it('routes every MCS_TEST_* hook through test-hooks.ts only', () => {
    for (const v of DOCUMENTED_ENV_VARS.filter((e) => e.name.startsWith('MCS_TEST_'))) {
      expect(v.readers, v.name).toEqual(['runtime/packages/engine/src/runtime/test-hooks.ts']);
    }
  });

  it('agrees with the MCS_* rows of the registry (98 section 6.3)', () => {
    const registry = readFileSync(
      fileURLToPath(new URL('../../../../docs/design/98-contract-registry.md', import.meta.url)),
      'utf8',
    );
    const start = registry.indexOf('### 6.3 Environment variables');
    const end = registry.indexOf('\n## 7.', start);
    expect(start).toBeGreaterThan(-1);
    const names = new Set<string>();
    for (const line of registry.slice(start, end).split('\n')) {
      const m = /^\| `([A-Z][A-Z0-9_]*)` \| (runtime|test|dev)\b/.exec(line);
      if (m?.[1] !== undefined && (m[1].startsWith('MCS_') || m[1] === 'CLAUDE_CONFIG_DIR')) names.add(m[1]);
    }
    expect([...names].sort()).toEqual(DOCUMENTED_ENV_VARS.map((v) => v.name).sort());
  });
});
