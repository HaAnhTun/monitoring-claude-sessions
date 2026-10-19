/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
  ['MCS_LAUNCHER_MODE', 'runtime'],
  ['MCS_DEBUG', 'runtime'],
  ['MCS_TEST', 'test'],
  ['MCS_TEST_IGNORE_CONTROL', 'test'],
  ['MCS_TEST_BOOT_HANG', 'test'],
  ['MCS_TEST_INIT_CRASH', 'test'],
  ['MCS_TEST_CASES', 'test'],
  ['MCS_PERF_FACTOR', 'test'],
  ['MCS_E2E_CLAUDE', 'test'],
  ['MCS_SHOTS_DIR', 'test'],
  ['MCS_SHOTS_VIEWS', 'test'],
  ['MCS_SHOTS_VIEWPORTS', 'test'],
  ['MCS_SHOTS_THEMES', 'test'],
  ['MCS_SHOTS_LOCALES', 'test'],
  ['MCS_SHOTS_MODE', 'test'],
  ['MCS_PW_CHANNEL', 'test'],
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

  it('has none of the variables of the Python era (ADR 0066)', () => {
    const removed = ['PYTHON', 'GOLDEN_LIVE_CONFIG', 'GOLDEN_LIVE_INPUTS', 'GOLDEN_DIR', 'PARITY_LIVE'].map(
      (n) => `MCS_${n}`,
    );
    for (const name of removed)
      expect(
        DOCUMENTED_ENV_VARS.some((v) => v.name === name),
        name,
      ).toBe(false);
  });

  it('has no trace of the ignored bootstrap variable in the sources, the scripts and the launcher (ADR 0062 item 4)', () => {
    const name = ['MCS_LAUNCHER', 'NO_BOOTSTRAP'].join('_');
    const skillRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const roots = ['skills/monitoring-claude-sessions/scripts', 'runtime/scripts'].map((r) => join(skillRoot, r));
    const packages = join(skillRoot, 'runtime/packages');
    for (const pkg of readdirSync(packages)) roots.push(join(packages, pkg, 'src'));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (
          /.(ts|mjs|json)$/.test(entry) &&
          !full.endsWith('env.test.ts') &&
          readFileSync(full, 'utf8').includes(name)
        )
          hits.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });

  it('has no trace of the ignored bootstrap variable in the sources, the scripts and the launcher (ADR 0062 item 4)', () => {
    const name = ['MCS_LAUNCHER', 'NO_BOOTSTRAP'].join('_');
    const skillRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const roots = ['skills/monitoring-claude-sessions/scripts', 'runtime/scripts'].map((r) => join(skillRoot, r));
    const packages = join(skillRoot, 'runtime/packages');
    for (const pkg of readdirSync(packages)) roots.push(join(packages, pkg, 'src'));
    const hits: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/[.](ts|mjs|json)$/.test(entry) && readFileSync(full, 'utf8').includes(name)) hits.push(full);
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
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

  it('routes every MCS_TEST_* hook through test-hooks.ts only; a test input is read by test files only', () => {
    const inputs = new Map([['MCS_TEST_CASES', ['runtime/packages/engine/src/lifecycle/properties.test.ts']]]);
    for (const v of DOCUMENTED_ENV_VARS.filter((e) => e.name.startsWith('MCS_TEST_'))) {
      const input = inputs.get(v.name);
      if (input === undefined) expect(v.readers, v.name).toEqual(['runtime/packages/engine/src/runtime/test-hooks.ts']);
      else expect(v.readers, v.name).toEqual(input);
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
