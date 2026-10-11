// Install and build stamps shared by `npm run build` and the launcher (scripts/mcs.mjs).
// Contract: docs/design/05-tooling-testing-security.md section 2.3. Zero dependencies.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PACKAGES, RUNTIME_ROOT, readJson } from './lib.mjs';

export const STAMP_SCHEMA_VERSION = 1;
export const BUILD_STAMP_FILE = '.mcs-build.json';
export const INSTALL_STAMP_FILE = join('node_modules', '.mcs-install.json');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test', 'test-results']);
const SKIP_FILE = /\.test\.(ts|tsx)$|^test-setup\.ts$/;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (!SKIP_FILE.test(entry.name)) {
      yield full;
    }
  }
}

function digest(root, files) {
  const hash = createHash('sha256');
  const rels = files.map((f) => relative(root, f).split(sep).join('/')).sort();
  for (const rel of rels) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Inputs that require `npm ci` when they change. */
export function installInputs(root = RUNTIME_ROOT) {
  return [join(root, 'package-lock.json'), join(root, '.npmrc')];
}

/** Inputs that require a rebuild when they change (production sources only; tests excluded). */
export function buildInputs(root = RUNTIME_ROOT) {
  const files = [
    join(root, 'package.json'),
    join(root, 'package-lock.json'),
    join(root, 'tsconfig.base.json'),
    join(root, 'tsconfig.build.json'),
  ];
  for (const pkg of PACKAGES) {
    if (pkg === 'testkit') continue;
    const dir = join(root, 'packages', pkg);
    files.push(join(dir, 'package.json'));
    for (const name of readdirSync(dir)) {
      if (/^(tsconfig.*\.json|vite\.config\.ts|index\.html)$/.test(name)) files.push(join(dir, name));
    }
    files.push(...walk(join(dir, 'src')));
    if (pkg === 'web') files.push(...walk(join(dir, 'public')));
  }
  return files;
}

export function computeStamps(root = RUNTIME_ROOT) {
  const platform = `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`;
  return {
    installStamp: `${platform}:${digest(root, installInputs(root))}`,
    buildStamp: digest(root, buildInputs(root)),
  };
}

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

function readOptional(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

/** Returns which steps are needed: { install: boolean, build: boolean, reasons: string[] }. */
export function staleness(root = RUNTIME_ROOT) {
  const now = computeStamps(root);
  const installed = readOptional(join(root, INSTALL_STAMP_FILE));
  const built = readOptional(join(root, BUILD_STAMP_FILE));
  const reasons = [];
  const install = installed?.installStamp !== now.installStamp;
  if (install) reasons.push(installed === null ? 'no install stamp' : 'lockfile, .npmrc or platform changed');
  const build = install || built?.buildStamp !== now.buildStamp;
  if (build && !install) reasons.push(built === null ? 'no build stamp' : 'sources changed since last build');
  return { install, build, reasons, ...now };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2] ?? 'check';
  const started = performance.now();
  const stamps = computeStamps();
  const root = readJson(join(RUNTIME_ROOT, 'package.json'));
  if (command === 'write') {
    writeAtomic(join(RUNTIME_ROOT, BUILD_STAMP_FILE), {
      schemaVersion: STAMP_SCHEMA_VERSION,
      runtimeVersion: root.version,
      buildStamp: stamps.buildStamp,
      codeStamp: stamps.buildStamp.slice(0, 10),
      node: process.version,
      builtAt: new Date().toISOString(),
    });
    console.log(`build-stamp: wrote ${BUILD_STAMP_FILE} ${stamps.buildStamp.slice(0, 10)}`);
  } else if (command === 'write-install') {
    writeAtomic(join(RUNTIME_ROOT, INSTALL_STAMP_FILE), {
      schemaVersion: STAMP_SCHEMA_VERSION,
      installStamp: stamps.installStamp,
      installedAt: new Date().toISOString(),
    });
    console.log('build-stamp: wrote install stamp');
  } else {
    const state = staleness();
    console.log(JSON.stringify({ ...state, ms: Math.round(performance.now() - started) }));
    process.exitCode = state.install || state.build ? 1 : 0;
  }
}
