// The deterministic bundle (ADR 0063, ADR 0062 items 1 and 5): two builds are byte-identical, the file set is fixed, no
// machine path leaks, the hook bundle is copy-safe, the manifest verifies, `--check` reports every difference, `--out` never
// touches the tracked bundle and the server bundle answers through Express (the `conditionNames` pitfall). The narrow allow-rule
// of ADR 0082 is here too: one literal `@lydell/node-pty` in the server and CLI bundles, `ws` bundled with its optional peers
// left external, native files only below `native/`. Builds go into temp folders; the tracked bundle is only read. Builds that
// are not about the native files pass `native: false` / `--no-native`, so this file needs no network.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as bundleModule from '../../scripts/bundle.mjs';
// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as stageModule from '../../scripts/native-stage.mjs';

interface Manifest {
  schemaVersion: number;
  runtimeVersion: string;
  buildStamp: string;
  codeStamp: string;
  files: Record<string, { bytes: number; sha256: string }>;
}
interface BundleOptions {
  outDir: string;
  entries?: Record<string, string>;
  web?: boolean;
  webDir?: string;
  native?: boolean | { targets?: string[] };
}
const {
  CONDITION_NAMES,
  ENTRIES,
  MIGRATIONS_DIR,
  REPO_ROOT,
  SKILL_DIR,
  TRACKED_BUNDLE_DIR,
  WEB_DIST_DIR,
  buildBundle,
  compareBundles,
  listFiles,
  manifestOf,
  rolldownOptions,
} = bundleModule as unknown as {
  CONDITION_NAMES: readonly string[];
  ENTRIES: Readonly<Record<string, string>>;
  MIGRATIONS_DIR: string;
  REPO_ROOT: string;
  SKILL_DIR: string;
  TRACKED_BUNDLE_DIR: string;
  WEB_DIST_DIR: string;
  buildBundle: (opts: BundleOptions) => Promise<{ files: string[]; packages: string[] }>;
  compareBundles: (a: string, b: string) => { changed: string[]; missing: string[]; extra: string[] };
  listFiles: (dir: string) => string[];
  manifestOf: (dir: string, version: string) => Manifest;
  rolldownOptions: (name: string, input: string) => { resolve: { conditionNames: string[] }; external: unknown[] };
};
const { readNativePins } = stageModule as unknown as {
  readNativePins: () => { targets: Record<string, { text: string[] }> };
};

const RUNTIME = join(import.meta.dirname, '..', '..');
const SCRIPT = join(RUNTIME, 'scripts', 'bundle.mjs');
const SMOKE = join(RUNTIME, 'scripts', 'smoke.mjs');
const BUILD_MS = 120_000;
const NODE_FILES = ['mcs-cli.mjs', 'mcs-hook.mjs', 'mcs-server.mjs'];
/**
 * Optional requires a bundled package wraps in try/catch and does without: `debug` probes `supports-color`, and `ws` probes its
 * optional peers `bufferutil` and `utf-8-validate`, which are native, not installed, and listed as `external` (ADR 0081, 0082).
 */
const OPTIONAL_REQUIRES = new Set(['supports-color', 'bufferutil', 'utf-8-validate']);
/** The one package the terminal may name at run time, the checkout fallback of the loader (ADR 0080, 0082), and the files that may. */
const TERMINAL_ADDON = '@lydell/node-pty';
const TERMINAL_FILES = ['mcs-cli.mjs', 'mcs-server.mjs'];
/** The platform of this run when its pinned package is installed: the real pins are then checked against `node_modules`. */
const HOST = `${process.platform}-${process.arch}`;
const HOST_INSTALLED =
  HOST in readNativePins().targets && existsSync(join(RUNTIME, 'node_modules', '@lydell', `node-pty-${HOST}`));
/**
 * Text that looks like a require call but is not one: the code generator of `ajv` (a dependency of the MCP SDK) keeps
 * `require("ajv/dist/runtime/validation_error")` (and `ajv-formats` the same for its formats) inside tagged templates that it
 * only emits into standalone validators, which this runtime never generates. The MCP bundle test (`packages/cli/test/mcp-bundle.int.test.ts`) runs the server from
 * the bundle alone.
 */
const GENERATED_CODE_TEXT = new Set(['ajv/dist/runtime/validation_error', 'ajv-formats/dist/formats']);
// The native SQLite addon that ADR 0064 rules out, spelled in parts: the driver boundary test of
// `engine/src/db/driver.test.ts` reads a call with this name as its first argument as an import.
const NATIVE_SQLITE = ['better', 'sqlite3'].join('-');

let root = '';
let first = '';
let second = '';

function bundleFiles(): string[] {
  const migrations = listFiles(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => `migrations/${f}`);
  return ['.mcs-build.json', 'THIRD-PARTY-NOTICES.txt', ...NODE_FILES, ...migrations].sort();
}

function runScript(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: RUNTIME, encoding: 'utf8', timeout: BUILD_MS });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function treeHash(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of listFiles(dir))
    out[rel] = createHash('sha256')
      .update(readFileSync(join(dir, rel)))
      .digest('hex');
  return out;
}

/** The code without comment lines and inline block comments (JSDoc examples mention `import('./x')` and `require('x')`). */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .map((line) => line.replace(/\/\*.*?\*\//g, ''))
    .join('\n');
}

/** Every module specifier of `import`/`export ... from`, `import '...'` and `import('...')` in `source`, outside comments. */
function importSpecifiers(source: string): string[] {
  const code = codeOnly(source);
  const specs: string[] = [];
  for (const re of [
    /^\s*(?:import|export)\s[^'";]*?\sfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(re)) specs.push(match[1] ?? '');
  }
  return specs;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcs-bundle-test-'));
  first = join(root, 'first');
  second = join(root, 'second');
  // `native: false`: these cases are about the Node entries; `bundle-native.test.ts` owns the native folder (no staging here)
  await buildBundle({ outDir: first, web: false, native: false });
  // the second build also proves that `web: false` never reads `packages/web/dist`
  await buildBundle({ outDir: second, web: false, webDir: join(root, 'no-web-dist'), native: false });
}, BUILD_MS);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('buildBundle', () => {
  it('builds byte-identical folders twice', () => {
    expect(listFiles(first)).toEqual(listFiles(second));
    expect(compareBundles(first, second)).toEqual({ changed: [], missing: [], extra: [] });
  });

  it('writes exactly the documented file set', () => {
    expect(listFiles(first)).toEqual(bundleFiles());
    expect(Object.keys(ENTRIES).map((name) => `${name}.mjs`)).toEqual([
      'mcs-cli.mjs',
      'mcs-server.mjs',
      'mcs-hook.mjs',
    ]);
  });

  it.skipIf(!existsSync(join(WEB_DIST_DIR, 'index.html')))(
    'copies the served web assets (no build report, no source map, no dot folder)',
    async () => {
      const withWeb = join(root, 'with-web');
      await buildBundle({ outDir: withWeb, web: true, native: false });
      const served = listFiles(WEB_DIST_DIR)
        .filter((rel) => !rel.split('/').some((part) => part.startsWith('.')))
        .filter((rel) => rel !== 'build-report.json' && !rel.endsWith('.map'))
        .map((rel) => `web/${rel}`);
      expect(listFiles(withWeb)).toEqual([...bundleFiles(), ...served].sort());
      expect(served).toContain('web/index.html');
    },
    BUILD_MS,
  );

  it('refuses a web build when packages/web/dist is missing', async () => {
    await expect(
      buildBundle({ outDir: join(root, 'refused'), webDir: join(root, 'missing'), native: false }),
    ).rejects.toThrow(/run npm run build first/);
    expect(existsSync(join(root, 'refused'))).toBe(false);
  });

  it('holds no path of the build machine and no install path in any .mjs', () => {
    const forms = [RUNTIME, REPO_ROOT, homedir(), tmpdir()].flatMap((p) => [p, p.replaceAll('\\', '/')]);
    for (const file of NODE_FILES) {
      const code = readFileSync(join(first, file), 'utf8');
      const lower = code.toLowerCase();
      for (const form of forms) expect(lower, `${file} holds ${form}`).not.toContain(form.toLowerCase());
      expect(code, file).not.toMatch(/node_modules[\\/]/);
      expect(code, file).not.toContain('\r');
    }
  });

  it('keeps the hook bundle copy-safe: only node:* imports, no require', () => {
    const code = readFileSync(join(first, 'mcs-hook.mjs'), 'utf8');
    const specs = importSpecifiers(code);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec, spec).toMatch(/^node:/);
    expect(codeOnly(code)).not.toMatch(/\brequire\s*\(/);
  });

  // The narrow allow-rule of ADR 0082 (it replaces "bundles no native addon"): the better-sqlite3 addon is still never in a bundle,
  // no file imports a package, and the only package a run-time `require` may name besides built-ins and the optional peers is the
  // terminal addon, in the CLI and server bundles only (the engine barrel pulls its loader into the CLI for `check`).
  it('bundles no native addon outside the pinned terminal files and requires no package at run time except the terminal source-mode fallback', () => {
    const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
    for (const file of NODE_FILES) {
      const code = readFileSync(join(first, file), 'utf8');
      const mayNameAddon = TERMINAL_FILES.includes(file);
      expect(code, file).not.toContain(NATIVE_SQLITE);
      for (const spec of importSpecifiers(code)) expect(spec, `${file}: ${spec}`).toMatch(/^node:/);
      for (const match of codeOnly(code).matchAll(/\b(?:__require|require)\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = match[1] ?? '';
        expect(
          builtins.has(spec) ||
            OPTIONAL_REQUIRES.has(spec) ||
            GENERATED_CODE_TEXT.has(spec) ||
            (mayNameAddon && spec === TERMINAL_ADDON),
          `${file} requires ${spec}`,
        ).toBe(true);
      }
      // the platform packages are never named, and the hook bundle (copy-safe) never names the addon at all
      expect(code, file).not.toContain(`${TERMINAL_ADDON}-`);
      if (!mayNameAddon) expect(codeOnly(code), file).not.toContain(TERMINAL_ADDON);
    }
  });

  it('keeps the terminal addon and the optional peers of ws out of the bundle through the external patterns', () => {
    for (const [name, input] of Object.entries(ENTRIES)) {
      const external = rolldownOptions(name, input).external;
      const matches = (spec: string): boolean => external.some((e) => e instanceof RegExp && e.test(spec));
      expect(matches('node:fs'), name).toBe(true);
      expect(matches(TERMINAL_ADDON), name).toBe(true);
      expect(matches(`${TERMINAL_ADDON}-win32-x64`), name).toBe(true);
      expect(matches('bufferutil'), name).toBe(true);
      expect(matches('utf-8-validate'), name).toBe(true);
      for (const bundled of ['ws', 'zod', 'express', 'bufferutil-extra', 'node-pty'])
        expect(matches(bundled), bundled).toBe(false);
    }
  });

  it(
    'bundles ws and leaves its optional peers external (a probe entry that imports ws)',
    async () => {
      const probe = join(root, 'ws-probe');
      mkdirSync(probe);
      // the probe lives outside the working tree; `ws` resolves through a junction to the runtime's node_modules
      const junction = join(probe, 'node_modules');
      symlinkSync(join(RUNTIME, 'node_modules'), junction, 'junction');
      writeFileSync(
        join(probe, 'entry.mjs'),
        "import { WebSocketServer } from 'ws';\nexport const kind = typeof WebSocketServer;\n",
      );
      const out = join(root, 'ws-out');
      try {
        const built = await buildBundle({
          outDir: out,
          entries: { 'ws-probe': join(probe, 'entry.mjs') },
          web: false,
          native: false,
        });
        const code = readFileSync(join(out, 'ws-probe.mjs'), 'utf8');
        const requires = [...codeOnly(code).matchAll(/\b(?:__require|require)\(\s*["']([^"']+)["']\s*\)/g)].map(
          (m) => m[1] ?? '',
        );
        const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
        expect(code, 'ws is inlined').toMatch(/^\/\/#region npm\/ws\/lib\/websocket-server\.js$/m);
        for (const spec of importSpecifiers(code)) expect(spec, spec).toMatch(/^node:/);
        expect(codeOnly(code)).not.toMatch(/\bfrom\s*["']ws["']|\brequire\(\s*["']ws["']\s*\)/);
        for (const spec of requires)
          expect(builtins.has(spec) || OPTIONAL_REQUIRES.has(spec), `requires ${spec}`).toBe(true);
        expect(requires, 'both optional peers stay a run-time require inside the try/catch of ws').toEqual(
          expect.arrayContaining(['bufferutil', 'utf-8-validate']),
        );
        expect(code).not.toMatch(/node_modules[\\/]/);
        expect(built.packages).toContain('ws@8.22.0');
        const notices = readFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
        expect(notices).toContain('\nws 8.22.0\nLicense: MIT\n');
      } finally {
        rmdirSync(junction);
      }
    },
    BUILD_MS,
  );

  it.runIf(HOST_INSTALLED)(
    'holds no path of the build machine in the native text files of a bundle built from the installed package',
    async () => {
      const out = join(root, 'with-native');
      await buildBundle({
        outDir: out,
        entries: { 'mcs-hook': ENTRIES['mcs-hook'] ?? '' },
        web: false,
        native: { targets: [HOST] },
      });
      const forms = [RUNTIME, REPO_ROOT, homedir(), tmpdir()].flatMap((p) => [p, p.replaceAll('\\', '/')]);
      const text = listFiles(join(out, 'native', HOST)).filter((rel) => /\.(?:js|json|md)$|^LICENSE$/.test(rel));
      expect(text.length).toBeGreaterThan(5);
      for (const rel of text) {
        const bytes = readFileSync(join(out, 'native', HOST, rel), 'utf8');
        for (const form of forms) expect(bytes.toLowerCase(), `${rel} holds ${form}`).not.toContain(form.toLowerCase());
        expect(bytes, rel).not.toContain('\r');
      }
    },
    BUILD_MS,
  );

  it('writes a manifest whose sizes and hashes verify, without a timestamp', () => {
    const manifest = JSON.parse(readFileSync(join(first, '.mcs-build.json'), 'utf8')) as Manifest;
    expect(Object.keys(manifest)).toEqual(['schemaVersion', 'runtimeVersion', 'buildStamp', 'codeStamp', 'files']);
    expect(manifest.schemaVersion).toBe(1);
    const version = (JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as { version: string }).version;
    expect(manifest.runtimeVersion).toBe(version);
    expect(Object.keys(manifest.files)).toEqual(listFiles(first).filter((rel) => rel !== '.mcs-build.json'));
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(first, rel));
      expect(entry, rel).toEqual({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    expect(manifestOf(first, version)).toEqual(manifest);
    expect(manifest.codeStamp).toBe(manifest.buildStamp.slice(0, 10));
  });

  it('never names import or require as a resolve condition (the is-promise pitfall)', () => {
    expect([...CONDITION_NAMES]).toEqual(['@mcs/source', 'node', 'module']);
    for (const [name, input] of Object.entries(ENTRIES)) {
      const conditions = rolldownOptions(name, input).resolve.conditionNames;
      expect(conditions).not.toContain('import');
      expect(conditions).not.toContain('require');
    }
  });
});

describe('node scripts/bundle.mjs', () => {
  it(
    '--check --against passes for an identical folder and names every changed, missing and extra file',
    () => {
      const copy = join(root, 'against');
      cpSync(first, copy, { recursive: true });
      const same = runScript(['--check', '--against', copy, '--no-web', '--no-native']);
      expect(same.stderr).toBe('');
      expect(same.status).toBe(0);
      appendFileSync(join(copy, 'mcs-hook.mjs'), ' ');
      unlinkSync(join(copy, 'THIRD-PARTY-NOTICES.txt'));
      writeFileSync(join(copy, 'extra.txt'), 'x\n');
      const changed = runScript(['--check', '--against', copy, '--no-web', '--no-native']);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain('bundle:check: differs: mcs-hook.mjs');
      expect(changed.stderr).toContain('bundle:check: missing: THIRD-PARTY-NOTICES.txt');
      expect(changed.stderr).toContain('bundle:check: extra: extra.txt');
      expect(changed.stderr).not.toContain('differs: mcs-cli.mjs');
    },
    BUILD_MS,
  );

  it(
    '--out writes the full bundle elsewhere and leaves the tracked bundle byte-identical',
    () => {
      const before = treeHash(TRACKED_BUNDLE_DIR);
      const out = join(root, 'out', 'bundle');
      const run = runScript(['--out', out, '--no-web', '--no-native']);
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(listFiles(out)).toEqual(bundleFiles());
      expect(treeHash(TRACKED_BUNDLE_DIR)).toEqual(before);
    },
    BUILD_MS,
  );

  it('--out into the tracked bundle or the repository is refused', () => {
    const before = treeHash(TRACKED_BUNDLE_DIR);
    for (const target of [TRACKED_BUNDLE_DIR, join(REPO_ROOT, 'bundle-out-test')]) {
      const run = runScript(['--out', target, '--no-web', '--no-native']);
      expect(run.status, target).toBe(1);
      expect(run.stderr).toContain('--out must be outside the repository');
    }
    expect(existsSync(join(REPO_ROOT, 'bundle-out-test'))).toBe(false);
    expect(treeHash(TRACKED_BUNDLE_DIR)).toEqual(before);
  });

  it('--no-native and --native-targets exclude each other, take a list of pinned targets and write nothing when refused', () => {
    const out = join(root, 'refused-native', 'bundle');
    const both = runScript(['--out', out, '--no-web', '--no-native', '--native-targets', 'win32-x64']);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain('--no-native and --native-targets exclude each other');
    const bare = runScript(['--out', out, '--no-web', '--native-targets']);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain('--native-targets needs a list');
    const unknown = runScript(['--out', out, '--no-web', '--native-targets', 'linux-x64']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown native target linux-x64');
    expect(existsSync(out)).toBe(false);
  });

  // `--native-targets <host>` stages from the installed package only (no network); `--check` stages the same way
  it.runIf(HOST_INSTALLED)(
    '--native-targets writes only the named target and --check compares the native folder too',
    () => {
      const out = join(root, 'native-out', 'bundle');
      const built = runScript(['--out', out, '--no-web', '--native-targets', HOST]);
      expect(built.stderr).toBe('');
      expect(built.status).toBe(0);
      const native = listFiles(out).filter((rel) => rel.startsWith('native/'));
      expect(native.length).toBeGreaterThan(10);
      expect(native.every((rel) => rel.startsWith(`native/${HOST}/`))).toBe(true);
      const same = runScript(['--check', '--against', out, '--no-web', '--native-targets', HOST]);
      expect(same.stderr).toBe('');
      expect(same.status).toBe(0);
      const target = native.find((rel) => rel.endsWith('/package.json')) ?? '';
      appendFileSync(join(out, target), ' ');
      unlinkSync(join(out, native.find((rel) => rel.endsWith('/LICENSE')) ?? ''));
      const changed = runScript(['--check', '--against', out, '--no-web', '--native-targets', HOST]);
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain(`bundle:check: differs: ${target}`);
      expect(changed.stderr).toContain(`bundle:check: missing: native/${HOST}/LICENSE`);
    },
    BUILD_MS * 3,
  );
});

describe('the server bundle in a temp skill copy', () => {
  it(
    'starts through the bundled CLI and answers GET /api/v3/health with 200 through Express',
    () => {
      const skill = join(root, 'skill');
      mkdirSync(skill);
      for (const entry of ['SKILL.md', 'config', 'runtime', 'scripts']) {
        cpSync(join(SKILL_DIR, entry), join(skill, entry), { recursive: true });
      }
      cpSync(first, join(skill, 'bundle'), { recursive: true });
      const smoke = spawnSync(process.execPath, [SMOKE, '--bundle', '--bundle-dir', join(skill, 'bundle')], {
        cwd: RUNTIME,
        encoding: 'utf8',
        timeout: BUILD_MS,
      });
      expect(smoke.stdout).toContain('health 200, foreign host 403');
      expect(smoke.status).toBe(0);
    },
    BUILD_MS,
  );
});

describe('.gitattributes', () => {
  it('marks the bundle folder as generated', () => {
    expect(readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8')).toMatch(
      /^skills\/\*\/bundle\/\*\* linguist-generated=true$/m,
    );
  });

  it('keeps the native files binary: no line-end conversion for .node, .dll and .exe below the bundle native folder', () => {
    const text = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
    for (const extension of ['node', 'dll', 'exe']) {
      expect(text, extension).toMatch(new RegExp(`^skills/\\*/bundle/native/\\*\\*/\\*\\.${extension} -text$`, 'm'));
    }
  });
});
