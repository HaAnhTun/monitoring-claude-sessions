// Lints the plain Node scripts that live outside the workspace (CR-WP-25-2, decision D-07): every
// `skills/*/scripts/*.mjs` and the root `install.mjs`, found at run time so that new launchers and the installer are
// covered without edits. The workspace `eslint.config.js` does not reach these files (ESLint ignores everything above
// its base path), so the test builds its own flat config and runs ESLint with the skill repository root as `cwd`.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import js from '@eslint/js';
import { ESLint, type Linter } from 'eslint';
import globals from 'globals';
import { afterAll, describe, expect, it } from 'vitest';

const SKILL_ROOT = join(import.meta.dirname, '..', '..', '..');

const CONFIG: Linter.Config[] = [
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-unused-vars': 'error', 'no-undef': 'error' },
  },
];

/** Relative paths (forward slashes) of the scripts to lint, below `root`. */
function scriptsOf(root: string): string[] {
  const found: string[] = [];
  const skillsDir = join(root, 'skills');
  if (existsSync(skillsDir)) {
    for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const scriptsDir = join(skillsDir, skill.name, 'scripts');
      if (!existsSync(scriptsDir)) continue;
      for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(`skills/${skill.name}/scripts/${entry.name}`);
      }
    }
  }
  if (existsSync(join(root, 'install.mjs'))) found.push('install.mjs');
  return found.sort();
}

async function lint(root: string, files: readonly string[]): Promise<ESLint.LintResult[]> {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: CONFIG });
  return eslint.lintFiles([...files]);
}

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('skill scripts lint', () => {
  it('finds at least the hook stub', () => {
    expect(scriptsOf(SKILL_ROOT)).toContain('skills/monitoring-claude-sessions/scripts/mcs-hook.mjs');
  });

  it('reports no message for any skill script or the installer', async () => {
    const files = scriptsOf(SKILL_ROOT);
    const results = await lint(SKILL_ROOT, files);
    expect(results).toHaveLength(files.length);
    const messages = results.flatMap((r) =>
      r.messages.map((m) => `${r.filePath}:${m.line}:${m.column} ${m.ruleId ?? 'fatal'} ${m.message}`),
    );
    expect(messages).toEqual([]);
  });

  it('reports an unused variable and an undefined name (negative control)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcs-script-lint-'));
    temps.push(root);
    const dir = join(root, 'skills', 'probe', 'scripts');
    cpSync(join(SKILL_ROOT, 'skills', 'monitoring-claude-sessions', 'scripts'), dir, { recursive: true });
    writeFileSync(
      join(dir, 'broken.mjs'),
      ['const unusedProbe = 1;', 'export function probe() {', '  return undefinedProbeName;', '}', ''].join('\n'),
    );
    const files = scriptsOf(root);
    expect(files).toContain('skills/probe/scripts/broken.mjs');
    const results = await lint(root, files);
    const broken = results.find((r) => r.filePath.endsWith('broken.mjs'));
    expect(broken?.messages.map((m) => m.ruleId).sort()).toEqual(['no-undef', 'no-unused-vars']);
    const others = results.filter((r) => r !== broken).flatMap((r) => r.messages);
    expect(others).toEqual([]);
  });
});
