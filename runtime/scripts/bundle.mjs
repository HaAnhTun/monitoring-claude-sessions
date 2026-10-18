// Deterministic bundle of the runtime (ADR 0063, ADR 0062 items 1 and 5): one rolldown build per entry into a fixed file
// list, the engine migrations, the prebuilt web assets, the third-party notices and a sorted `.mcs-build.json` manifest.
// Usage:
//   node scripts/bundle.mjs                          write the tracked bundle (`skills/monitoring-claude-sessions/bundle`)
//   node scripts/bundle.mjs --out <dir> [--no-web]   write a complete bundle into another folder (never the tracked one)
//   node scripts/bundle.mjs --check [--against <dir>] [--no-web]   build into a temp folder and compare, never write
// `buildBundle({ outDir, entries?, web? })` is the programmatic form (tests of other areas build into temp folders with it).
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectNotices, renderNotices } from './bundle-notices.mjs';
import { RUNTIME_ROOT, readJson } from './lib.mjs';

/** The bundle entries: output name -> source entry (relative to the runtime root). The MCP area adds its entry here. */
export const ENTRIES = Object.freeze({
  'mcs-cli': 'packages/cli/src/main.ts',
  'mcs-server': 'packages/server/src/main.ts',
  'mcs-hook': 'packages/cli/src/hook.ts',
});

/**
 * Resolve conditions. Never `import` or `require`: rolldown adds them per import kind, and pinning `import` makes
 * `require('is-promise')` (Express 5) return the ES module namespace, so every request fails (ADR 0063 item 3).
 */
export const CONDITION_NAMES = Object.freeze(['@mcs/source', 'node', 'module']);

export const REPO_ROOT = resolve(RUNTIME_ROOT, '..');
export const SKILL_DIR = join(REPO_ROOT, 'skills', 'monitoring-claude-sessions');
export const TRACKED_BUNDLE_DIR = join(SKILL_DIR, 'bundle');
export const WEB_DIST_DIR = join(RUNTIME_ROOT, 'packages', 'web', 'dist');
export const MIGRATIONS_DIR = join(RUNTIME_ROOT, 'packages', 'engine', 'migrations');
export const MANIFEST_FILE = '.mcs-build.json';
export const NOTICES_FILE = 'THIRD-PARTY-NOTICES.txt';
export const MANIFEST_SCHEMA_VERSION = 1;

/** Web build files the server never serves (ADR 0039): not part of the bundle. */
const WEB_SKIP_FILE = /^build-report\.json$|\.map$/;

/** The rolldown options of one entry; exported so the `conditionNames` regression test can read them. */
export function rolldownOptions(name, input) {
  return {
    cwd: RUNTIME_ROOT,
    input: { [name]: input },
    platform: 'node',
    resolve: { conditionNames: [...CONDITION_NAMES] },
    external: [/^node:/],
    treeshake: true,
    logLevel: 'warn',
    write: false,
    output: {
      format: 'esm',
      entryFileNames: '[name].mjs',
      codeSplitting: false,
      minify: false,
      sourcemap: false,
      comments: { legal: false },
    },
  };
}

async function loadRolldown() {
  try {
    return await import('rolldown');
  } catch (error) {
    throw new Error(
      `rolldown is not installed (${error instanceof Error ? error.message : String(error)}): run npm ci in runtime/`,
      { cause: error },
    );
  }
}

const toPosix = (p) => p.split(sep).join('/');

/** Region comments name modules by their runtime-relative path; `node_modules/` becomes `npm/` (no install path in the bundle). */
export function normalizeCode(code) {
  return code
    .replace(/\r\n?/g, '\n')
    .replace(
      /^(\/\/#(?:end)?region )(.*)$/gm,
      (_, head, path) => head + path.replace(/(^|\/)node_modules\//g, '$1npm/'),
    );
}

function* walk(dir, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else yield toPosix(relative(base, full));
  }
}

/** Every file below `dir` as sorted posix paths (empty when the folder does not exist). */
export function listFiles(dir) {
  return existsSync(dir) ? [...walk(dir)].sort() : [];
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The manifest of ADR 0062 item 5: no timestamp, no Node version, sorted `files`. */
export function manifestOf(dir, runtimeVersion) {
  const files = {};
  const stamp = createHash('sha256');
  for (const rel of listFiles(dir)) {
    if (rel === MANIFEST_FILE) continue;
    const bytes = readFileSync(join(dir, rel));
    files[rel] = { bytes: bytes.length, sha256: sha256(bytes) };
    stamp.update(rel);
    stamp.update('\0');
    stamp.update(bytes);
    stamp.update('\0');
  }
  const buildStamp = stamp.digest('hex');
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runtimeVersion,
    buildStamp,
    codeStamp: buildStamp.slice(0, 10),
    files,
  };
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function copyTree(from, to, skip) {
  for (const rel of listFiles(from)) {
    if (rel.split('/').some((part) => part.startsWith('.')) || skip.test(rel.split('/').pop() ?? '')) continue;
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    copyFileSync(join(from, rel), join(to, rel));
  }
}

/**
 * Builds a complete bundle into `outDir` (created; it must be empty or missing). `web: false` skips the web assets and works
 * without `packages/web/dist`. Resolves to `{ files, packages }` (the sorted file list and the bundled third-party packages).
 */
export async function buildBundle({ outDir, entries = ENTRIES, web = true, webDir = WEB_DIST_DIR } = {}) {
  if (typeof outDir !== 'string' || outDir === '') throw new Error('buildBundle: outDir is required');
  if (web && !existsSync(join(webDir, 'index.html'))) {
    throw new Error('packages/web/dist is missing: run npm run build first (or pass --no-web)');
  }
  if (listFiles(outDir).length > 0) throw new Error(`bundle: the output folder is not empty: ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const { build } = await loadRolldown();
  const moduleIds = [];
  const texts = [];
  for (const [name, input] of Object.entries(entries)) {
    const result = await build(rolldownOptions(name, input));
    const chunks = result.output.filter((o) => o.type === 'chunk');
    if (chunks.length !== 1 || result.output.length !== 1) {
      throw new Error(`bundle: ${name} produced ${result.output.length} files, expected one chunk`);
    }
    const code = normalizeCode(chunks[0].code);
    write(join(outDir, `${name}.mjs`), code);
    moduleIds.push(...chunks[0].moduleIds);
    texts.push(code);
  }
  copyTree(MIGRATIONS_DIR, join(outDir, 'migrations'), /^(?!.*\.sql$)/);
  if (web) copyTree(webDir, join(outDir, 'web'), WEB_SKIP_FILE);
  const notices = collectNotices({ moduleIds, bundleText: texts.join('\n'), includeWeb: web });
  write(join(outDir, NOTICES_FILE), renderNotices(notices));
  const runtimeVersion = readJson(join(RUNTIME_ROOT, 'package.json')).version;
  write(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifestOf(outDir, runtimeVersion), null, 2)}\n`);
  return { files: listFiles(outDir), packages: notices.map((n) => `${n.name}@${n.version}`) };
}

/** Differences between two bundle folders: `{ changed, missing, extra }` (paths relative to the folders, sorted). */
export function compareBundles(expectedDir, actualDir) {
  const expected = new Set(listFiles(expectedDir));
  const actual = new Set(listFiles(actualDir));
  const changed = [];
  const missing = [];
  for (const rel of expected) {
    if (!actual.has(rel)) missing.push(rel);
    else if (!readFileSync(join(expectedDir, rel)).equals(readFileSync(join(actualDir, rel)))) changed.push(rel);
  }
  const extra = [...actual].filter((rel) => !expected.has(rel));
  return { changed, missing, extra };
}

const inside = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel));
};

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `mcs-bundle-${label}-`));
}

/** Replaces the tracked bundle folder with a fresh build (built aside first, so a failed build leaves the folder as it was). */
async function writeTracked(web) {
  const staging = tempDir('write');
  try {
    const built = join(staging, 'bundle');
    await buildBundle({ outDir: built, web });
    rmSync(TRACKED_BUNDLE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    mkdirSync(TRACKED_BUNDLE_DIR, { recursive: true });
    for (const rel of listFiles(built)) {
      mkdirSync(dirname(join(TRACKED_BUNDLE_DIR, rel)), { recursive: true });
      copyFileSync(join(built, rel), join(TRACKED_BUNDLE_DIR, rel));
    }
    return listFiles(TRACKED_BUNDLE_DIR);
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function writeOut(outDir, web) {
  const target = resolve(outDir);
  if (inside(TRACKED_BUNDLE_DIR, target) || inside(REPO_ROOT, target)) {
    throw new Error(
      `bundle: --out must be outside the repository (use npm run bundle for the tracked bundle): ${outDir}`,
    );
  }
  const staging = tempDir('out');
  try {
    const built = join(staging, 'bundle');
    await buildBundle({ outDir: built, web });
    if (listFiles(target).length > 0) throw new Error(`bundle: the output folder is not empty: ${outDir}`);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    try {
      renameSync(built, target);
    } catch {
      mkdirSync(target, { recursive: true });
      for (const rel of listFiles(built)) {
        mkdirSync(dirname(join(target, rel)), { recursive: true });
        copyFileSync(join(built, rel), join(target, rel));
      }
    }
    return listFiles(target);
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** `--check`: 0 when a fresh build equals `against` byte for byte, else 1 with every differing, missing and extra path. */
async function check(against, web) {
  const staging = tempDir('check');
  try {
    const fresh = join(staging, 'bundle');
    await buildBundle({ outDir: fresh, web });
    const { changed, missing, extra } = compareBundles(fresh, against);
    const lines = [
      ...changed.map((rel) => `bundle:check: differs: ${rel}`),
      ...missing.map((rel) => `bundle:check: missing: ${rel}`),
      ...extra.map((rel) => `bundle:check: extra: ${rel}`),
    ];
    if (lines.length === 0) {
      console.log(`bundle:check: OK (${listFiles(fresh).length} files equal a fresh build)`);
      return 0;
    }
    for (const line of lines) console.error(line);
    console.error(
      `bundle:check: FAIL (${lines.length} difference${lines.length === 1 ? '' : 's'}): ` +
        'run `npm run build && npm run bundle` in runtime/ and commit the bundle',
    );
    return 1;
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function parseArgs(argv) {
  const opts = { check: false, web: true, out: null, against: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--no-web') opts.web = false;
    else if (arg === '--out' || arg === '--against') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`bundle: ${arg} needs a folder`);
      opts[arg.slice(2)] = value;
      i += 1;
    } else throw new Error(`bundle: unknown argument ${arg}`);
  }
  if (opts.against !== null && !opts.check) throw new Error('bundle: --against needs --check');
  if (opts.out !== null && opts.check) throw new Error('bundle: --out and --check exclude each other');
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.check) {
      process.exitCode = await check(opts.against ?? TRACKED_BUNDLE_DIR, opts.web);
    } else {
      const files = opts.out === null ? await writeTracked(opts.web) : await writeOut(opts.out, opts.web);
      const where = opts.out === null ? toPosix(relative(REPO_ROOT, TRACKED_BUNDLE_DIR)) : opts.out;
      console.log(`bundle: wrote ${files.length} files to ${where}`);
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
