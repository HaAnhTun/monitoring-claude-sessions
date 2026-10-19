// The stable copy of the hook script (ADR 0070): copy-safe sources only, atomic replace, created / refreshed / current, a link
// at the destination is replaced and never followed, and nothing is written in the source layout.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McsError } from '@mcs/shared';
import { makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { readSmallFile } from '../../platform/fsx.ts';
import { hooksFolder } from './manifest.ts';
import {
  HOOK_SCRIPT_NAME,
  foreignImports,
  hookScriptState,
  installHookScript,
  planHookScript,
  readHookSource,
  removeHookScript,
  stableScriptPath,
} from './script-copy.ts';
import { sha256Hex } from './settings-io.ts';

const makeTemp = useTempDirs();
const SKILL = fileURLToPath(new URL('../../../../../../', import.meta.url));
const TRACKED_HOOK = path.join(SKILL, 'skills', 'monitoring-claude-sessions', 'bundle', HOOK_SCRIPT_NAME);

const HANDLER_V1 = 'import { readFileSync } from "node:fs";\nexport const VERSION = "FIXTURE-1";\n';
const HANDLER_V2 = 'import { readFileSync } from "node:fs";\nexport const VERSION = "FIXTURE-2";\n';

interface Setup {
  readonly root: string;
  readonly mcsHome: string;
  readonly source: string;
  readonly copy: string;
}

function setup(content = HANDLER_V1): Setup {
  const root = makeTemp('script-copy').path;
  const bundle = path.join(root, 'skill', 'bundle');
  mkdirSync(bundle, { recursive: true });
  const source = path.join(bundle, HOOK_SCRIPT_NAME);
  writeFileSync(source, content);
  const mcsHome = path.join(root, 'mcs-home');
  return { root, mcsHome, source, copy: path.join(mcsHome, 'hooks', HOOK_SCRIPT_NAME) };
}

async function reason(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    if (error instanceof McsError) return error.details?.['reason'];
    throw error;
  }
  throw new Error('expected a McsError');
}

/** A link where the copy goes, leading to a decoy folder with a canary file (a junction on Windows, no privilege needed). */
function linkAtCopy(s: Setup): { decoy: string; canary: string } {
  const decoy = path.join(s.root, 'decoy');
  mkdirSync(decoy);
  const canary = path.join(decoy, 'canary.txt');
  writeFileSync(canary, 'FIXTURE canary');
  mkdirSync(path.dirname(s.copy), { recursive: true });
  makeJunction(s.copy, decoy);
  return { decoy, canary };
}

describe('foreignImports', () => {
  it('finds nothing in a file that imports only Node built-ins', () => {
    const text = [
      'import { a } from "node:fs";',
      "import b from 'node:path';",
      'import "node:process";',
      'export { c } from "node:url";',
      'const lazy = await import("node:crypto");',
      '',
    ].join('\n');
    expect(foreignImports(text)).toEqual([]);
  });

  it('names relative modules, packages and dynamic imports', () => {
    const text = [
      'import { a } from "./sibling.js";',
      "import { b } from '../other.js';",
      'import c from "zod";',
      'import "side-effect";',
      'export * from "./reexport.js";',
      'const x = await import("./lazy.js");',
      'import {',
      '  d,',
      '} from "multi-line";',
    ].join('\n');
    expect(foreignImports(text).sort()).toEqual(
      ['./lazy.js', './reexport.js', './sibling.js', '../other.js', 'multi-line', 'side-effect', 'zod'].sort(),
    );
  });

  it('does not take words inside code or strings for imports', () => {
    expect(foreignImports('const s = "read from the file";\nconst t = `import of data`;\nx.from("y");\n')).toEqual([]);
  });

  it('accepts the committed hook bundle', () => {
    if (!existsSync(TRACKED_HOOK)) return; // a checkout before the first bundle: the integration suite builds one
    expect(foreignImports(readFileSync(TRACKED_HOOK, 'utf8'))).toEqual([]);
  });
});

describe('readHookSource', () => {
  it('reads a self-contained mcs-hook.mjs with its hash', async () => {
    const s = setup();
    const source = await readHookSource(s.source);
    expect(source.bytes.toString('utf8')).toBe(HANDLER_V1);
    expect(source.sha256).toBe(sha256Hex(HANDLER_V1));
  });

  it('refuses the source layout: dist/hook.js is not copy-safe, and nothing is written', async () => {
    const s = setup();
    const dist = path.join(s.root, 'checkout', 'runtime', 'packages', 'cli', 'dist');
    mkdirSync(dist, { recursive: true });
    const hook = path.join(dist, 'hook.js');
    writeFileSync(hook, 'import { runHook } from "./hook/main.js";\nrunHook(process.argv);\n');
    expect(await reason(() => readHookSource(hook))).toBe('HOOK_BUNDLE_MISSING');
    expect(await reason(() => installHookScript({ source: hook, mcsHome: s.mcsHome }))).toBe('HOOK_BUNDLE_MISSING');
    expect(existsSync(s.mcsHome)).toBe(false);
  });

  it('says what to do', async () => {
    const s = setup();
    try {
      await readHookSource(path.join(s.root, 'hook.js'));
    } catch (error) {
      expect(error).toBeInstanceOf(McsError);
      expect((error as McsError).hint).toMatch(/npm run bundle.*install the skill/);
      return;
    }
    throw new Error('expected a refusal');
  });

  it('refuses a file called mcs-hook.mjs that imports a sibling', async () => {
    const s = setup('import { runHook } from "./hook/main.js";\n');
    expect(await reason(() => readHookSource(s.source))).toBe('HOOK_BUNDLE_MISSING');
  });

  it('refuses a missing source and a source above the size limit', async () => {
    const s = setup();
    expect(await reason(() => readHookSource(path.join(s.root, 'nowhere', HOOK_SCRIPT_NAME)))).toBe(
      'HOOK_BUNDLE_MISSING',
    );
    writeFileSync(s.source, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    expect(await reason(() => readHookSource(s.source))).toBe('HOOK_BUNDLE_MISSING');
  });
});

describe('stableScriptPath', () => {
  it('is $MCS_HOME/hooks/mcs-hook.mjs with forward slashes', () => {
    const s = setup();
    expect(stableScriptPath(s.mcsHome)).toBe(path.join(s.mcsHome, 'hooks', 'mcs-hook.mjs').split(path.sep).join('/'));
    expect(stableScriptPath(s.mcsHome)).not.toContain('\\');
  });
});

describe('planHookScript writes nothing', () => {
  it('reports created, refreshed and current without touching MCS_HOME', async () => {
    const s = setup();
    expect(await planHookScript(s)).toEqual({
      action: 'created',
      path: stableScriptPath(s.mcsHome),
      sha256: sha256Hex(HANDLER_V1),
    });
    expect(existsSync(s.mcsHome)).toBe(false);
    await installHookScript(s);
    expect((await planHookScript(s)).action).toBe('current');
    writeFileSync(s.source, HANDLER_V2);
    const before = readFileSync(s.copy);
    expect((await planHookScript(s)).action).toBe('refreshed');
    expect(readFileSync(s.copy).equals(before)).toBe(true);
  });
});

describe('installHookScript', () => {
  it('creates the copy with the bytes of the source and leaves no temporary file', async () => {
    const s = setup();
    const result = await installHookScript(s);
    expect(result).toEqual({ action: 'created', path: stableScriptPath(s.mcsHome), sha256: sha256Hex(HANDLER_V1) });
    expect(readFileSync(s.copy, 'utf8')).toBe(HANDLER_V1);
    expect(readdirSync(hooksFolder(s.mcsHome))).toEqual([HOOK_SCRIPT_NAME]);
  });

  it('a second install of the same source is current and does not rewrite the file', async () => {
    const s = setup();
    await installHookScript(s);
    const before = statSync(s.copy);
    const again = await installHookScript(s);
    expect(again.action).toBe('current');
    expect(statSync(s.copy).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(s.copy).ino).toBe(before.ino);
  });

  it('after the source changes (a plugin update) the copy is refreshed', async () => {
    const s = setup();
    await installHookScript(s);
    writeFileSync(s.source, HANDLER_V2);
    const result = await installHookScript(s);
    expect(result).toEqual({ action: 'refreshed', path: stableScriptPath(s.mcsHome), sha256: sha256Hex(HANDLER_V2) });
    expect(readFileSync(s.copy, 'utf8')).toBe(HANDLER_V2);
    expect((await installHookScript(s)).action).toBe('current');
  });

  it('repairs a copy that was edited or truncated', async () => {
    const s = setup();
    await installHookScript(s);
    writeFileSync(s.copy, '');
    expect((await installHookScript(s)).action).toBe('refreshed');
    expect(readFileSync(s.copy, 'utf8')).toBe(HANDLER_V1);
  });

  it('a concurrent reader never sees a half-written copy', async () => {
    const big = (tag: string): string => `import "node:fs";\n// ${tag.repeat(300_000 / tag.length)}\n`;
    const a = big('A');
    const b = big('B');
    const s = setup(a);
    await installHookScript(s);
    const state = { writing: true };
    const seen = new Set<string>();
    const failures: string[] = [];
    // A reader that opens the file again and again, as a starting hook process does (with a short pause: on Windows a rename
    // cannot replace a file that is open, and the installer retries, so a reader that never lets go would only slow it down).
    const reader = (async () => {
      while (state.writing) {
        try {
          seen.add(sha256Hex(await readSmallFile(s.copy, 1024 * 1024)));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        for (let pause = 0; pause < 400; pause += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })();
    try {
      for (let i = 0; i < 6; i += 1) {
        writeFileSync(s.source, i % 2 === 0 ? b : a);
        expect((await installHookScript(s)).action).toBe('refreshed');
      }
    } finally {
      state.writing = false;
      await reader;
    }
    expect(failures).toEqual([]);
    expect([...seen].every((hash) => hash === sha256Hex(a) || hash === sha256Hex(b))).toBe(true);
    expect(seen.size).toBeGreaterThan(0);
  }, 60_000);

  it('refuses a folder where the copy goes', async () => {
    const s = setup();
    mkdirSync(s.copy, { recursive: true });
    expect(await reason(() => installHookScript(s))).toBe('SCRIPT_COPY_FAILED');
    expect(lstatSync(s.copy).isDirectory()).toBe(true);
  });

  it('replaces a link at the destination and does not write through it', async () => {
    const s = setup();
    const { decoy, canary } = linkAtCopy(s);
    const result = await installHookScript(s);
    expect(result.action).toBe('refreshed');
    expect(lstatSync(s.copy).isSymbolicLink()).toBe(false);
    expect(readFileSync(s.copy, 'utf8')).toBe(HANDLER_V1);
    expect(readdirSync(decoy)).toEqual(['canary.txt']);
    expect(readFileSync(canary, 'utf8')).toBe('FIXTURE canary');
  });

  it('runs the test guard first: a MCS_HOME outside the temporary folder is refused before the source is looked at', async () => {
    const outside = path.join(path.parse(os.tmpdir()).root, 'FIXTURE-not-the-temp-folder', 'mcs-home');
    const missingSource = path.join(makeTemp('script-copy').path, 'nowhere', HOOK_SCRIPT_NAME);
    expect(
      await reason(() => installHookScript({ source: missingSource, mcsHome: outside, env: { MCS_TEST: '1' } })),
    ).toBe('REAL_SETTINGS_IN_TEST');
    expect(
      await reason(() => planHookScript({ source: missingSource, mcsHome: outside, env: { VITEST: 'true' } })),
    ).toBe('REAL_SETTINGS_IN_TEST');
    expect(await reason(() => removeHookScript({ mcsHome: outside, env: { MCS_TEST: '1' } }))).toBe(
      'REAL_SETTINGS_IN_TEST',
    );
    expect(
      await reason(() => hookScriptState({ source: missingSource, mcsHome: outside, env: { MCS_TEST: '1' } })),
    ).toBe('REAL_SETTINGS_IN_TEST');
  });
});

describe('removeHookScript', () => {
  it('removes the copy, then reports it absent', async () => {
    const s = setup();
    await installHookScript(s);
    expect(await removeHookScript(s)).toBe('removed');
    expect(existsSync(s.copy)).toBe(false);
    expect(await removeHookScript(s)).toBe('absent');
  });

  it('removes a link without touching its target', async () => {
    const s = setup();
    const { decoy, canary } = linkAtCopy(s);
    expect(await removeHookScript(s)).toBe('removed');
    expect(existsSync(s.copy)).toBe(false);
    expect(readdirSync(decoy)).toEqual(['canary.txt']);
    expect(readFileSync(canary, 'utf8')).toBe('FIXTURE canary');
  });
});

describe('hookScriptState', () => {
  it('is missing, current, stale or unknown', async () => {
    const s = setup();
    expect(await hookScriptState(s)).toBe('missing');
    await installHookScript(s);
    expect(await hookScriptState(s)).toBe('current');
    writeFileSync(s.source, HANDLER_V2);
    expect(await hookScriptState(s)).toBe('stale');
    expect(await hookScriptState({ ...s, source: path.join(s.root, 'nowhere', HOOK_SCRIPT_NAME) })).toBe('unknown');
    expect(await hookScriptState({ ...s, source: path.join(s.root, 'hook.js') })).toBe('unknown');
  });
});
