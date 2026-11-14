/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DOCUMENTED_ENV_VARS, type DocumentedEnvVar, legacyNamesInUse } from './env.ts';
import { CLI_ALIAS, CLI_NAME, PRODUCT_NAME } from './product.ts';

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

/**
 * Runtime variables that still carry their historical `MCS_*` name. The flip work package renames them to `CAW_*` with a
 * `legacyName` and empties this list; until then no other runtime entry may keep the old prefix.
 */
const UNFLIPPED_RUNTIME: readonly string[] = [
  'MCS_LOG_LEVEL',
  'MCS_HOOK_DISABLE',
  'MCS_HOME',
  'MCS_FS_WATCH',
  'MCS_LAUNCHER_MODE',
  'MCS_DEBUG',
];

/** The registry rules of 07 section 4.1, as a function so that the rules themselves are tested on samples. */
function registryProblems(vars: readonly DocumentedEnvVar[], unflipped: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const v of vars) {
    if (v.scope === 'runtime') {
      const canonical = v.name.startsWith('CAW_') || v.name === 'CLAUDE_CONFIG_DIR';
      if (!canonical && !unflipped.includes(v.name)) problems.push(`${v.name}: a runtime name is CAW_*`);
      if (v.legacyName !== undefined) {
        if (!v.name.startsWith('CAW_')) problems.push(`${v.name}: only a CAW_* entry has a legacyName`);
        else if (v.legacyName !== `MCS_${v.name.slice('CAW_'.length)}`) {
          problems.push(`${v.name}: legacyName must be MCS_ plus the same suffix`);
        }
      }
    } else if (v.legacyName !== undefined) {
      problems.push(`${v.name}: a ${v.scope} entry has no legacyName`);
    }
  }
  return problems;
}

describe('registry rules (07 section 4.1)', () => {
  it('holds for the registry, with the runtime names that are not flipped yet', () => {
    expect(registryProblems(DOCUMENTED_ENV_VARS, UNFLIPPED_RUNTIME)).toEqual([]);
  });

  it('keeps the unflipped list honest: each entry is a runtime name without a legacyName', () => {
    for (const name of UNFLIPPED_RUNTIME) {
      const entry = DOCUMENTED_ENV_VARS.find((v) => v.name === name);
      expect(entry?.scope, name).toBe('runtime');
      expect(entry?.legacyName, name).toBeUndefined();
    }
  });

  it('pairs every legacyName with its canonical name', () => {
    for (const v of DOCUMENTED_ENV_VARS.filter((e) => e.legacyName !== undefined)) {
      expect(v.name, v.name).toMatch(/^CAW_[A-Z0-9_]*[A-Z0-9]$/);
      expect(v.legacyName, v.name).toBe(`MCS_${v.name.slice(4)}`);
    }
  });

  it('has no name that is also the legacyName of another entry', () => {
    const names = new Set(DOCUMENTED_ENV_VARS.map((v) => v.name));
    for (const v of DOCUMENTED_ENV_VARS)
      if (v.legacyName !== undefined) expect(names.has(v.legacyName), v.name).toBe(false);
  });

  it('accepts a flipped runtime entry, an unchanged test or dev entry and a .bat reader', () => {
    const ok: DocumentedEnvVar[] = [
      { name: 'CAW_SAMPLE', legacyName: 'MCS_SAMPLE', scope: 'runtime', readers: ['a.ts'] },
      { name: 'CAW_NODE_SAMPLE', scope: 'runtime', readers: ['skills/x/scripts/start.bat'] },
      { name: 'CLAUDE_CONFIG_DIR', scope: 'runtime', readers: ['a.ts'] },
      { name: 'MCS_TEST_SAMPLE', scope: 'test', readers: ['a.ts'] },
      { name: 'CAW_REAL_SAMPLE', scope: 'test', readers: ['a.ts'] },
      { name: 'MCS_WEB_SAMPLE', scope: 'dev', readers: ['a.ts'] },
    ];
    expect(registryProblems(ok)).toEqual([]);
  });

  it('rejects a new runtime entry named MCS_*, a wrong legacyName and a legacyName outside the runtime scope', () => {
    const bad: DocumentedEnvVar[] = [
      { name: 'MCS_NEW', scope: 'runtime', readers: ['a.ts'] },
      { name: 'CAW_ONE', legacyName: 'MCS_TWO', scope: 'runtime', readers: ['a.ts'] },
      { name: 'CLAUDE_CONFIG_DIR', legacyName: 'MCS_CONFIG', scope: 'runtime', readers: ['a.ts'] },
      { name: 'MCS_TEST_X', legacyName: 'CAW_TEST_X', scope: 'test', readers: ['a.ts'] },
      { name: 'MCS_DEV_X', legacyName: 'CAW_DEV_X', scope: 'dev', readers: ['a.ts'] },
    ];
    expect(registryProblems(bad)).toEqual([
      'MCS_NEW: a runtime name is CAW_*',
      'CAW_ONE: legacyName must be MCS_ plus the same suffix',
      'CLAUDE_CONFIG_DIR: only a CAW_* entry has a legacyName',
      'MCS_TEST_X: a test entry has no legacyName',
      'MCS_DEV_X: a dev entry has no legacyName',
    ]);
  });
});

describe('legacyNamesInUse', () => {
  const vars: readonly DocumentedEnvVar[] = [
    { name: 'CAW_ONE', legacyName: 'MCS_ONE', scope: 'runtime', readers: ['a.ts'] },
    { name: 'CAW_TWO', legacyName: 'MCS_TWO', scope: 'runtime', readers: ['a.ts'] },
    { name: 'CAW_THREE', scope: 'runtime', readers: ['a.ts'] },
    { name: 'MCS_TEST_FOUR', scope: 'test', readers: ['a.ts'] },
  ];

  it('is empty when no legacy name is set', () => {
    expect(legacyNamesInUse({}, vars)).toEqual([]);
    expect(legacyNamesInUse({ CAW_ONE: 'x', UNRELATED: 'y' }, vars)).toEqual([]);
  });

  it('lists a legacy name that is set while its canonical name is not, names only', () => {
    expect(legacyNamesInUse({ MCS_ONE: 'secret-looking-value', MCS_TWO: '' }, vars)).toEqual(['MCS_ONE', 'MCS_TWO']);
  });

  it('does not list a legacy name that its canonical name overrides', () => {
    expect(legacyNamesInUse({ MCS_ONE: 'a', CAW_ONE: 'b', MCS_TWO: 'c' }, vars)).toEqual(['MCS_TWO']);
    expect(legacyNamesInUse({ MCS_ONE: 'a', CAW_ONE: '' }, vars)).toEqual([]);
  });

  it('ignores an undefined value, a variable without a legacyName and a test variable', () => {
    expect(legacyNamesInUse({ MCS_ONE: undefined, MCS_THREE: 'x', MCS_TEST_FOUR: '1' }, vars)).toEqual([]);
  });

  it('answers for the real registry without arguments, in registry order', () => {
    expect(legacyNamesInUse({})).toEqual([]);
    const flipped = DOCUMENTED_ENV_VARS.filter((v) => v.legacyName !== undefined);
    const env: Record<string, string> = {};
    for (const v of flipped) env[v.legacyName ?? ''] = '1';
    expect(legacyNamesInUse(env)).toEqual(flipped.map((v) => v.legacyName));
  });
});

describe('product constants', () => {
  it('names the product and the command line', () => {
    expect(PRODUCT_NAME).toBe('Claude Agent Workspace');
    expect(CLI_NAME).toBe('mcs');
    expect(CLI_ALIAS).toBe('mcs');
  });
});

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
