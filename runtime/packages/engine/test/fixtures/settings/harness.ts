// A temporary world for the installer tests: an MCS_HOME, a Claude config folder, a settings file path, a bundled hook script and
// the environment that turns the test guard on. Everything lies below one temporary folder (rule 8 of the plan: no real path).
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  applyHooks,
  type ApplyHooksInput,
  type HooksOutcome,
  type HooksSeams,
  type UninstallHooksInput,
} from '../../../src/hooks/installer/apply.ts';
import { realSettingsIo } from '../../../src/hooks/installer/settings-io.ts';
import { uninstallHooks } from '../../../src/hooks/installer/uninstall.ts';

export const HANDLER_V1 = 'import { readFileSync } from "node:fs";\nexport const VERSION = "FIXTURE-1";\n';
export const HANDLER_V2 = 'import { readFileSync } from "node:fs";\nexport const VERSION = "FIXTURE-2";\n';

export const FIXTURE_CLOCK_MS = Date.UTC(2026, 9, 11, 14, 5, 7, 100);
export const NODE_PATH = 'C:/FIXTURE/node.exe';

export interface Harness {
  readonly root: string;
  readonly mcsHome: string;
  readonly claudeHome: string;
  readonly settingsPath: string;
  /** The bundled hook script (`<root>/skill/bundle/mcs-hook.mjs`). */
  readonly source: string;
  /** The environment with the test guard on and every state folder in the temporary world. */
  readonly env: Record<string, string>;
  /** The time the installer sees; move it to age the backups. */
  readonly clock: { now: number };
  readonly seams: Partial<HooksSeams>;
  install(over?: Partial<ApplyHooksInput>): Promise<HooksOutcome>;
  uninstall(over?: Partial<UninstallHooksInput>): Promise<HooksOutcome>;
  settings(): string;
  writeSettings(text: string): void;
  setSource(content: string): void;
}

/** `make` is the factory of `useTempDirs()` in the test file, so the folder is removed after the test. */
export function makeHarness(make: (purpose: string) => { readonly path: string }): Harness {
  const root = make('hooks-installer').path;
  const mcsHome = path.join(root, 'mcs-home');
  const claudeHome = path.join(root, 'claude-home');
  const settingsPath = path.join(claudeHome, 'settings.json');
  const bundle = path.join(root, 'skill', 'bundle');
  mkdirSync(bundle, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  const source = path.join(bundle, 'mcs-hook.mjs');
  writeFileSync(source, HANDLER_V1);
  const clock = { now: FIXTURE_CLOCK_MS };
  const env = { MCS_TEST: '1', VITEST: 'true', MCS_HOME: mcsHome, CLAUDE_CONFIG_DIR: claudeHome, HOME: root };
  const seams: Partial<HooksSeams> = { now: () => clock.now, homedir: () => root };
  const base = { scope: 'file', settingsPath, mcsHome, env, yes: true, seams } as const;
  return {
    root,
    mcsHome,
    claudeHome,
    settingsPath,
    source,
    env,
    clock,
    seams,
    install: (over = {}) => applyHooks({ ...base, source, nodePath: NODE_PATH, ...over }),
    uninstall: (over = {}) => uninstallHooks({ ...base, ...over }),
    settings: () => readFileSync(settingsPath, 'utf8'),
    writeSettings: (text) => {
      writeFileSync(settingsPath, text);
    },
    setSource: (content) => {
      writeFileSync(source, content);
    },
  };
}

/** `Partial<HooksSeams>` that keeps the real file system calls except the ones given. */
export function withIo(h: Harness, io: Partial<typeof realSettingsIo>): Partial<HooksSeams> {
  return { ...h.seams, io: { ...realSettingsIo, ...io } };
}

/** Every file below `dir` with its hash, and every folder: a comparison of two of these says whether anything changed. */
export function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const key = `${prefix}${entry}`;
      if (lstatSync(full).isDirectory()) {
        out[`${key}/`] = 'dir';
        walk(full, `${key}/`);
      } else {
        out[key] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

/** `true` when the folder or file does not exist at all. */
export function absent(file: string): boolean {
  return !existsSync(file);
}
