// Regression test for the lint guarantees of 05 section 2.6: every probe of experiments E6, E7 and E24 is written into an
// isolated temporary copy of the lint setup, linted with the real `eslint.config.js` through the ESLint Node API, and the
// exact rule id of every guarded finding is asserted per line. The probes never touch the working tree, so a concurrent
// `eslint .` or `tsc -p` of another agent cannot see them (the F-7 question of 05 2.6, whether `projectService` accepts a
// file that its tsconfig excludes, therefore never arises and `probe.tsconfig.json` is not needed).
import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const RUNTIME = join(import.meta.dirname, '..', '..');
const PROBE_PACKAGES = ['shared', 'engine', 'server', 'cli', 'web'] as const;

/** `[line, ruleId]` plus an optional fragment of the message (to tell apart the per-package variants of one rule). */
type Finding = readonly [line: number, ruleId: string, messagePart?: string];

interface Probe {
  /** Path below the probe root, forward slashes. */
  readonly file: string;
  readonly lines: readonly string[];
  /** Every guarded finding of the file; nothing else guarded may appear. */
  readonly expect: readonly Finding[];
}

interface Reported {
  readonly line: number;
  readonly ruleId: string | null;
  readonly message: string;
  readonly fatal: boolean;
}

/**
 * Rules whose findings are asserted exactly. Other findings (the `no-unsafe-*` side effects of deliberately broken code,
 * unused names) are ignored.
 */
const GUARDED_IDS = new Set([
  'eqeqeq',
  'no-console',
  'no-eval',
  'no-new-func',
  'no-script-url',
  'no-restricted-imports',
  'no-restricted-syntax',
  'no-restricted-properties',
  'no-restricted-globals',
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/consistent-type-assertions',
  '@typescript-eslint/no-non-null-assertion',
  '@typescript-eslint/consistent-type-imports',
  '@typescript-eslint/no-import-type-side-effects',
  '@typescript-eslint/switch-exhaustiveness-check',
  '@typescript-eslint/no-implied-eval',
]);
const GUARDED_PREFIXES = ['react-hooks/', 'jsx-a11y/'];

function isGuarded(ruleId: string | null): boolean {
  return ruleId !== null && (GUARDED_IDS.has(ruleId) || GUARDED_PREFIXES.some((prefix) => ruleId.startsWith(prefix)));
}

const IMPORTS = 'no-restricted-imports';
const SYNTAX = 'no-restricted-syntax';
const PROPS = 'no-restricted-properties';
const GLOBALS = 'no-restricted-globals';

/** The platform/stdio probe of E24: line 2 `process.platform`, line 3 `os.platform()`, line 4 `process.stdout`. */
const PLATFORM_LINES = [
  "import os from 'node:os';",
  'export const a = process.platform;',
  'export const b = os.platform();',
  "process.stdout.write('x');",
];

const PROBES: readonly Probe[] = [
  // ---- all TypeScript (probed in engine/src/probe, a folder without a path-specific rule beyond the engine layering)
  {
    file: 'packages/engine/src/probe/any.ts',
    lines: ['export const v: any = 1;'],
    expect: [[1, '@typescript-eslint/no-explicit-any']],
  },
  {
    file: 'packages/engine/src/probe/assertion.ts',
    lines: ["export const n = JSON.parse('1') as number;"],
    expect: [[1, '@typescript-eslint/consistent-type-assertions']],
  },
  {
    file: 'packages/engine/src/probe/as-const.ts',
    lines: ["export const c = ['a'] as const;"],
    expect: [],
  },
  {
    file: 'packages/engine/src/probe/non-null.ts',
    lines: ['const m = new Map<string, number>();', "export const x = m.get('a')!;"],
    expect: [[2, '@typescript-eslint/no-non-null-assertion']],
  },
  {
    file: 'packages/engine/src/probe/switch.ts',
    lines: [
      "type K = 'a' | 'b';",
      'export function f(k: K): number {',
      '  switch (k) {',
      "    case 'a':",
      '      return 1;',
      '  }',
      '  return 0;',
      '}',
    ],
    expect: [[3, '@typescript-eslint/switch-exhaustiveness-check']],
  },
  {
    file: 'packages/engine/src/probe/types.ts',
    lines: ['export interface Foo {', '  a: number;', '}'],
    expect: [],
  },
  {
    file: 'packages/engine/src/probe/type-import.ts',
    lines: ["import { Foo } from './types.ts';", 'export const f = (x: Foo): number => x.a;'],
    expect: [[1, '@typescript-eslint/consistent-type-imports']],
  },
  {
    file: 'packages/engine/src/probe/type-import-side-effect.ts',
    lines: ["import { type Foo } from './types.ts';", 'export const f = (x: Foo): number => x.a;'],
    expect: [[1, '@typescript-eslint/no-import-type-side-effects']],
  },
  {
    file: 'packages/engine/src/probe/loose-equality.ts',
    lines: ['export const same = (a: number, b: number): boolean => a == b;'],
    expect: [[1, 'eqeqeq']],
  },
  // ---- raw HTML: all four forms
  {
    file: 'packages/engine/src/probe/html.ts',
    lines: [
      'export function f(el: { innerHTML: string; outerHTML: string; insertAdjacentHTML(p: string, h: string): void }): void {',
      "  el.innerHTML = 'x';",
      "  el.outerHTML = 'x';",
      "  el.insertAdjacentHTML('beforeend', 'x');",
      '}',
      'declare const document: { write(s: string): void; writeln(s: string): void };',
      "document.write('x');",
      "document.writeln('x');",
    ],
    expect: [
      [2, SYNTAX],
      [3, SYNTAX],
      [4, SYNTAX],
      [7, SYNTAX],
      [8, SYNTAX],
    ],
  },
  {
    file: 'packages/web/src/probe/Html.tsx',
    lines: ["export const X = () => <div dangerouslySetInnerHTML={{ __html: 'x' }} />;"],
    expect: [[1, SYNTAX]],
  },
  // ---- eval, console, shell
  {
    file: 'packages/engine/src/probe/eval.ts',
    lines: ["eval('1');", "export const f = new Function('return 1');"],
    expect: [
      [1, 'no-eval'],
      [2, 'no-new-func'],
      [2, '@typescript-eslint/no-implied-eval'],
    ],
  },
  {
    file: 'packages/engine/src/probe/console.ts',
    lines: ["console.log('x');"],
    expect: [[1, 'no-console']],
  },
  {
    file: 'packages/engine/src/probe/shell.ts',
    lines: ['export const options = { shell: true };', 'export const safe = { shell: false };'],
    expect: [[1, SYNTAX]],
  },
  // ---- process streams and platform branching (E24)
  {
    file: 'packages/engine/src/panels/x.ts',
    lines: PLATFORM_LINES,
    expect: [
      [2, PROPS],
      [3, SYNTAX],
      [4, PROPS],
    ],
  },
  { file: 'packages/engine/src/platform/x.ts', lines: PLATFORM_LINES, expect: [[4, PROPS]] },
  { file: 'packages/engine/src/security/paths.ts', lines: PLATFORM_LINES, expect: [[4, PROPS]] },
  {
    file: 'packages/engine/src/log/logger.ts',
    lines: PLATFORM_LINES,
    expect: [
      [2, PROPS],
      [3, SYNTAX],
    ],
  },
  { file: 'packages/engine/src/panels/x.test.ts', lines: PLATFORM_LINES, expect: [] },
  { file: 'packages/server/src/x.ts', lines: PLATFORM_LINES, expect: [[4, PROPS]] },
  { file: 'packages/cli/src/x.ts', lines: PLATFORM_LINES, expect: [[4, PROPS]] },
  { file: 'packages/cli/src/io/terminal.ts', lines: PLATFORM_LINES, expect: [] },
  {
    file: 'packages/shared/src/protocol/x.ts',
    lines: PLATFORM_LINES,
    expect: [[1, IMPORTS, 'protocol is dependency-free']],
  },
  // ---- processes and the SQLite driver live in one module each (E6, E22)
  {
    file: 'packages/engine/src/panels/spawn.ts',
    lines: ["import { spawn } from 'node:child_process';", 'export const s = spawn;'],
    expect: [[1, IMPORTS, 'Only engine/src/platform/exec.ts starts processes']],
  },
  {
    file: 'packages/engine/src/platform/exec.ts',
    lines: ["import { execFile, exec } from 'node:child_process';", 'export const s = [execFile, exec];'],
    expect: [[1, IMPORTS, 'execFileText']],
  },
  {
    file: 'packages/engine/src/panels/driver.ts',
    lines: ["import Database from 'better-sqlite3';", 'export const d = Database;'],
    expect: [[1, IMPORTS, 'Only engine/src/db/driver.ts opens the driver']],
  },
  {
    file: 'packages/engine/src/db/driver.ts',
    lines: ["import Database from 'better-sqlite3';", 'export const d = Database;'],
    expect: [],
  },
  {
    file: 'packages/server/src/spawn.ts',
    lines: [
      "import { spawn } from 'node:child_process';",
      "import Database from 'better-sqlite3';",
      'export const s = [spawn, Database];',
    ],
    expect: [
      [1, IMPORTS, 'never starts processes'],
      [2, IMPORTS, 'Use engine repositories'],
    ],
  },
  {
    file: 'packages/cli/src/spawn.ts',
    lines: [
      "import { spawn } from 'node:child_process';",
      "import Database from 'better-sqlite3';",
      'export const s = [spawn, Database];',
    ],
    expect: [
      [1, IMPORTS, 'execFileText'],
      [2, IMPORTS, 'Use engine repositories'],
    ],
  },
  // ---- layering per package
  {
    file: 'packages/shared/src/layering.ts',
    lines: [
      "import { readFileSync } from 'node:fs';",
      "import { x } from '@mcs/engine';",
      "import express from 'express';",
      "import { useState } from 'react';",
      'export const all = [readFileSync, x, express, useState];',
    ],
    expect: [
      [1, IMPORTS, 'Node built-ins'],
      [2, IMPORTS, 'depends only on zod'],
      [3, IMPORTS, 'depends only on zod'],
      [4, IMPORTS, 'depends only on zod'],
    ],
  },
  {
    file: 'packages/shared/src/protocol/layering.ts',
    lines: [
      "import { z } from 'zod';",
      "import { a } from '../ids.ts';",
      "import { b } from './sibling.ts';",
      'export const all = [z, a, b];',
    ],
    expect: [
      [1, IMPORTS, 'protocol is dependency-free'],
      [2, IMPORTS, 'zod-based part'],
    ],
  },
  {
    file: 'packages/engine/src/layering.ts',
    lines: [
      "import { a } from '@mcs/server';",
      "import { b } from '@mcs/cli';",
      "import { c } from '@mcs/web';",
      "import { d } from '@mcs/testkit';",
      "import e from 'express';",
      "import { f } from 'react';",
      "import { g } from '@mcs/shared';",
      'export const all = [a, b, c, d, e, f, g];',
    ],
    expect: [
      [1, IMPORTS, 'engine must not depend'],
      [2, IMPORTS, 'engine must not depend'],
      [3, IMPORTS, 'engine must not depend'],
      [4, IMPORTS, 'engine must not depend'],
      [5, IMPORTS, 'engine must not depend'],
      [6, IMPORTS, 'engine must not depend'],
    ],
  },
  {
    file: 'packages/server/src/layering.ts',
    lines: [
      "import { a } from '@mcs/cli';",
      "import { b } from '@mcs/web';",
      "import { c } from '@mcs/testkit';",
      "import { d } from 'react';",
      "import { e } from '@mcs/engine';",
      'export const all = [a, b, c, d, e];',
    ],
    expect: [
      [1, IMPORTS, 'server depends on engine and shared only'],
      [2, IMPORTS, 'server depends on engine and shared only'],
      [3, IMPORTS, 'server depends on engine and shared only'],
      [4, IMPORTS, 'server depends on engine and shared only'],
    ],
  },
  {
    file: 'packages/cli/src/layering.ts',
    lines: [
      "import { a } from '@mcs/server';",
      "import { b } from '@mcs/web';",
      "import { c } from '@mcs/testkit';",
      "import d from 'express';",
      "import { e } from 'react';",
      "import { f } from '@mcs/engine';",
      'export const all = [a, b, c, d, e, f];',
    ],
    expect: [
      [1, IMPORTS, 'cli depends on engine and shared only'],
      [2, IMPORTS, 'cli depends on engine and shared only'],
      [3, IMPORTS, 'cli depends on engine and shared only'],
      [4, IMPORTS, 'cli depends on engine and shared only'],
      [5, IMPORTS, 'cli depends on engine and shared only'],
    ],
  },
  {
    file: 'packages/web/src/layering.ts',
    lines: [
      "import { readFileSync } from 'node:fs';",
      "import { a } from '@mcs/engine';",
      "import { z } from 'zod';",
      "import { b } from 'react-router-dom';",
      "import { c } from 'react-markdown';",
      "import { d } from 'lucide-react';",
      "import { e } from '../test/helpers.ts';",
      "import { f } from '@mcs/shared';",
      'export const all = [readFileSync, a, z, b, c, d, e, f];',
    ],
    expect: [
      [1, IMPORTS, 'browser'],
      [2, IMPORTS, 'only @mcs/shared'],
      [3, IMPORTS, 'only @mcs/shared'],
      [4, IMPORTS, 'react-router'],
      [5, IMPORTS, 'Markdown'],
      [6, IMPORTS, 'icons.ts'],
      [7, IMPORTS, 'never imports test code'],
    ],
  },
  // CR-WP-48-1: the Node builtin ban matches the module only; a web folder named `stream` (04-ui.md 4.2) stays importable
  {
    file: 'packages/web/src/probe/stream-folder.ts',
    lines: [
      "import { a } from '../stream/x.ts';",
      "import { b } from './stream/y.ts';",
      "import { c } from '../../stream/z.ts';",
      "import { d } from 'node:stream';",
      "import { e } from 'stream';",
      "import { f } from 'stream/web';",
      "import { g } from 'node:stream/promises';",
      "import { h } from 'path';",
      "import { i } from '../path/x.ts';",
      'export const all = [a, b, c, d, e, f, g, h, i];',
    ],
    expect: [
      [4, IMPORTS, 'browser'],
      [5, IMPORTS, 'browser'],
      [6, IMPORTS, 'browser'],
      [7, IMPORTS, 'browser'],
      [8, IMPORTS, 'browser'],
    ],
  },
  {
    file: 'packages/web/src/components/icons.ts',
    lines: ["import { Check } from 'lucide-react';", 'export const icon = Check;'],
    expect: [],
  },
  {
    file: 'packages/web/src/lib/pure.ts',
    lines: [
      "import { useState } from 'react';",
      "import { x } from '@tanstack/react-query';",
      'export const all = [useState, x];',
    ],
    expect: [
      [1, IMPORTS, 'lib/ is pure'],
      [2, IMPORTS, 'lib/ is pure'],
    ],
  },
  // ---- the hook handler stays tiny
  {
    file: 'packages/cli/src/hook.ts',
    lines: [
      "import { z } from 'zod';",
      "import { a } from '@mcs/shared';",
      "import { b } from '../io/terminal.ts';",
      "import { createHash } from 'node:crypto';",
      "import { c } from '@mcs/shared/protocol';",
      "import { d } from './hook/sibling.ts';",
      'export const all = [z, a, b, createHash, c, d];',
    ],
    expect: [
      [1, IMPORTS, 'hook handler imports only'],
      [2, IMPORTS, 'hook handler imports only'],
      [3, IMPORTS, 'hook handler imports only'],
    ],
  },
  // ---- no deep imports, banned packages
  {
    file: 'packages/server/src/deep.ts',
    lines: [
      "import { a } from '@mcs/shared/src/ids.ts';",
      "import { b } from '@mcs/engine/dist/index.js';",
      "import { c } from '../../../shared/src/ids.ts';",
      "import { d } from '../local.ts';",
      'export const all = [a, b, c, d];',
    ],
    expect: [
      [1, IMPORTS, 'exports map'],
      [2, IMPORTS, 'exports map'],
      [3, IMPORTS, 'workspace package'],
    ],
  },
  {
    file: 'packages/engine/src/probe/banned.ts',
    lines: ["import axios from 'axios';", "import moment from 'moment';", 'export const all = [axios, moment];'],
    expect: [
      [1, IMPORTS, 'Banned dependency'],
      [2, IMPORTS, 'Banned dependency'],
    ],
  },
  // ---- web: computed links, script URLs, globals owned by one module
  {
    file: 'packages/web/src/probe/Link.tsx',
    lines: [
      'export const Computed = ({ u }: { u: string }) => <a href={u}>x</a>;',
      'export const Blank = () => (',
      '  <a href="/x" target="_blank">',
      '    x',
      '  </a>',
      ');',
    ],
    expect: [
      [1, SYNTAX],
      [3, SYNTAX],
    ],
  },
  {
    file: 'packages/web/src/probe/script-url.ts',
    lines: ["export const url = 'javascript:void(0)';"],
    expect: [[1, 'no-script-url']],
  },
  {
    file: 'packages/web/src/probe/globals.ts',
    lines: [
      "export const a = fetch('/x');",
      "export const b = new EventSource('/x');",
      "export const c = localStorage.getItem('k');",
      "export const d = sessionStorage.getItem('k');",
    ],
    expect: [
      [1, GLOBALS],
      [2, GLOBALS],
      [3, GLOBALS],
      [4, GLOBALS],
    ],
  },
  {
    file: 'packages/web/src/data/api-client.ts',
    lines: ["export const a = fetch('/x');", "export const b = new EventSource('/x');"],
    expect: [[2, GLOBALS]],
  },
  {
    file: 'packages/web/src/stream/stream-client.ts',
    lines: ["export const a = fetch('/x');", "export const b = new EventSource('/x');"],
    expect: [[1, GLOBALS]],
  },
  {
    file: 'packages/web/src/lib/prefs.ts',
    lines: [
      "export const a = localStorage.getItem('k');",
      "export const b = sessionStorage.getItem('k');",
      "export const c = fetch('/x');",
    ],
    expect: [[3, GLOBALS]],
  },
  // ---- React correctness and accessibility
  {
    file: 'packages/web/src/probe/Hooks.tsx',
    lines: [
      "import { useState } from 'react';",
      'export function C({ a }: { a: boolean }) {',
      '  if (a) {',
      '    useState(1);',
      '  }',
      '  return null;',
      '}',
    ],
    expect: [[4, 'react-hooks/rules-of-hooks']],
  },
  {
    file: 'packages/web/src/probe/A11y.tsx',
    lines: [
      'export const Img = () => <img src="/x.png" />;',
      'export const Click = () => <div onClick={() => undefined} />;',
    ],
    expect: [
      [1, 'jsx-a11y/alt-text'],
      [2, 'jsx-a11y/click-events-have-key-events'],
      [2, 'jsx-a11y/no-static-element-interactions'],
    ],
  },
  // ---- tests: sleeps are banned, assertions and process streams are allowed
  {
    file: 'packages/engine/src/probe/sleep.test.ts',
    lines: [
      'setTimeout(() => undefined, 1);',
      "export const n = JSON.parse('1') as number;",
      "process.stdout.write('x');",
      "export const m = new Map<string, number>().get('a')!;",
    ],
    expect: [[1, SYNTAX]],
  },
  {
    file: 'tests/probe/sleep.test.ts',
    lines: ['setTimeout(() => undefined, 1);'],
    expect: [[1, SYNTAX]],
  },
];

let root = '';
let findings = new Map<string, readonly Reported[]>();

function writeProbe(probe: Probe): void {
  const target = join(root, probe.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${probe.lines.join('\n')}\n`);
}

function removeProbeRoot(): void {
  if (root === '') return;
  const junction = join(root, 'node_modules');
  try {
    // Remove only the link: `rmSync(..., { recursive })` must never be pointed at the real node_modules.
    if (lstatSync(junction).isSymbolicLink()) rmdirSync(junction);
  } catch {
    // the junction was never created
  }
  rmSync(root, { recursive: true, force: true });
  root = '';
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcs-lint-probe-'));
  try {
    for (const name of ['eslint.config.js', 'tsconfig.base.json', 'tsconfig.check.json']) {
      cpSync(join(RUNTIME, name), join(root, name));
    }
    for (const name of PROBE_PACKAGES) {
      mkdirSync(join(root, 'packages', name), { recursive: true });
      cpSync(join(RUNTIME, 'packages', name, 'tsconfig.json'), join(root, 'packages', name, 'tsconfig.json'));
    }
    // The real `tests/` project of the workspace types the `tests/**` probe.
    mkdirSync(join(root, 'tests'), { recursive: true });
    cpSync(join(RUNTIME, 'tests', 'tsconfig.json'), join(root, 'tests', 'tsconfig.json'));
    symlinkSync(join(RUNTIME, 'node_modules'), join(root, 'node_modules'), 'junction');
    for (const probe of PROBES) writeProbe(probe);

    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: join(root, 'eslint.config.js'),
      ignore: false,
      errorOnUnmatchedPattern: false,
    });
    const results = await eslint.lintFiles(PROBES.map((probe) => join(root, probe.file)));
    findings = new Map(
      results.map((result) => {
        const relative = result.filePath
          .slice(root.length + 1)
          .split(sep)
          .join('/');
        const messages = result.messages.map((m) => ({
          line: m.line,
          ruleId: m.ruleId,
          message: m.message,
          fatal: m.fatal === true,
        }));
        return [relative, messages];
      }),
    );
  } catch (error) {
    removeProbeRoot();
    throw error;
  }
}, 240_000);

afterAll(() => {
  removeProbeRoot();
});

describe('lint probes (05 section 2.6, E6/E7/E24)', () => {
  it('lints every probe file without a parse error', () => {
    expect([...findings.keys()].sort()).toEqual(PROBES.map((probe) => probe.file).sort());
    for (const [file, messages] of findings) {
      expect(
        messages.filter((m) => m.fatal || m.ruleId === null),
        file,
      ).toEqual([]);
    }
  });

  it.each(PROBES.map((probe) => [probe.file, probe] as const))(
    '%s reports exactly the expected guarded findings',
    (file, probe) => {
      const actual = (findings.get(file) ?? []).filter((m) => isGuarded(m.ruleId));
      const asKey = (line: number, ruleId: string | null) => `${line}:${ruleId ?? ''}`;
      expect(actual.map((m) => asKey(m.line, m.ruleId)).sort()).toEqual(
        probe.expect.map(([line, ruleId]) => asKey(line, ruleId)).sort(),
      );
      for (const [line, ruleId, part] of probe.expect) {
        if (part === undefined) continue;
        const match = actual.find((m) => m.line === line && m.ruleId === ruleId);
        expect(match?.message, `${file}:${line}`).toContain(part);
      }
    },
  );
});
