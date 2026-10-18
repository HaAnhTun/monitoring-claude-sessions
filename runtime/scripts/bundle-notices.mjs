// Third-party notices of the bundle (ADR 0063 item 6): every third-party package that is part of a bundle (the modules rolldown
// reports for the Node entries plus the production dependency closure of `@mcs/web` from the lockfile) with name, version, SPDX
// licence and licence text; sorted, LF only, no dates. A licence outside the allow list fails the build. Zero dependencies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { RUNTIME_ROOT, readJson } from './lib.mjs';

/** SPDX ids a bundled package may carry (ADR 0063 item 6). */
export const ALLOWED_LICENSES = Object.freeze([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
]);

/** The line a package without a licence text file gets instead of the text. */
export const NO_LICENSE_FILE_MARKER =
  '(The package ships no licence file; the SPDX id above is taken from its package.json.)';

/**
 * Code that a bundled package already contains inside its own dist file (a vendored library is not a module of its own, so
 * rolldown does not report it). Each entry: `name`, `version`, `license` (SPDX), `text` (the licence text) and `pattern` (a
 * RegExp that finds the vendored code in the bundle text). A dependency that vendors another library adds its entry here.
 */
export const EMBEDDED_NOTICES = Object.freeze([]);

const LICENSE_FILE = /^(licen[cs]e|copying)(\.[a-z0-9]+|-[a-z0-9.-]+)?$/i;

const toPosix = (p) => p.split(sep).join('/');

/** The lockfile key (`node_modules/a` or `node_modules/a/node_modules/@s/b`) of a module path, or null for first-party code. */
export function packageKeyOf(moduleId, root = RUNTIME_ROOT) {
  if (moduleId.startsWith('\0')) return null;
  const rel = toPosix(relative(root, moduleId));
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(rel);
  return match === null ? null : match[1];
}

/** Resolves `name` from the lockfile folder `from` the way Node does: nested `node_modules` first, then each ancestor. */
export function resolveInLock(packages, from, name) {
  let dir = from;
  for (;;) {
    const key = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[key] !== undefined) return key;
    if (dir === '') return null;
    const cut = dir.lastIndexOf('/node_modules/');
    dir = cut >= 0 ? dir.slice(0, cut) : '';
  }
}

function runtimeDeps(entry) {
  const optionalPeers = entry.peerDependenciesMeta ?? {};
  const peers = Object.keys(entry.peerDependencies ?? {}).filter((n) => optionalPeers[n]?.optional !== true);
  return [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...peers];
}

/**
 * The production dependency closure of the workspace folder `start` (e.g. `packages/web`) in a lockfile v2/v3: the third-party
 * lockfile keys reached through `dependencies`, `optionalDependencies` and required peers, following workspace links. Dev
 * dependencies are never followed. Sorted.
 */
export function productionClosure(lock, start) {
  const packages = lock.packages ?? {};
  const seen = new Set();
  const third = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    seen.add(key);
    let entry = packages[key];
    let folder = key;
    if (entry === undefined) continue;
    if (entry.link === true && typeof entry.resolved === 'string') {
      folder = entry.resolved;
      entry = packages[folder] ?? {};
    } else if (key.includes('node_modules/')) {
      third.add(key);
    }
    for (const name of runtimeDeps(entry)) {
      const dep = resolveInLock(packages, folder, name);
      if (dep !== null) queue.push(dep);
    }
  }
  return [...third].sort();
}

function licenseText(dir) {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name))
    .sort()[0];
  if (file === undefined) return null;
  return readFileSync(join(dir, file), 'utf8')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

function spdxOf(entry, manifest) {
  const value = entry.license ?? manifest?.license;
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && typeof value.type === 'string') return value.type;
  return 'UNKNOWN';
}

/** One notice per lockfile key: `{ name, version, license, text }` (`text` null when the package ships no licence file). */
export function noticeOf(lock, key, root = RUNTIME_ROOT) {
  const entry = lock.packages?.[key];
  if (entry === undefined) throw new Error(`notices: ${key} is not in the lockfile`);
  const dir = join(root, ...key.split('/'));
  const manifestFile = join(dir, 'package.json');
  const manifest = existsSync(manifestFile) ? readJson(manifestFile) : null;
  const name = entry.name ?? manifest?.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return {
    name,
    version: entry.version ?? manifest?.version ?? '0.0.0',
    license: spdxOf(entry, manifest),
    text: licenseText(dir),
  };
}

/** Throws when a licence is outside the allow list (an `(A OR B)` expression passes when one choice is allowed). */
export function assertAllowed(notices, allowed = ALLOWED_LICENSES) {
  const bad = notices.filter((n) => {
    const choices = n.license.replace(/^\(|\)$/g, '').split(/\s+OR\s+/);
    return !choices.some((c) => allowed.includes(c.trim()));
  });
  if (bad.length > 0) {
    throw new Error(
      `notices: licence not in the allow list: ${bad.map((n) => `${n.name}@${n.version} (${n.license})`).join(', ')}`,
    );
  }
}

/** The embedded notices whose pattern matches the bundle text; an entry without its licence text fails. */
export function embeddedNotices(bundleText, table = EMBEDDED_NOTICES) {
  const found = [];
  for (const entry of table) {
    if (!entry.pattern.test(bundleText)) continue;
    if (typeof entry.text !== 'string' || entry.text.trim() === '' || !entry.name || !entry.version || !entry.license) {
      throw new Error(`notices: the bundle contains ${entry.name ?? 'vendored code'} but its notice is incomplete`);
    }
    found.push({ name: entry.name, version: entry.version, license: entry.license, text: entry.text.trim() });
  }
  return found;
}

function compareNotices(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
}

/**
 * The notices of a bundle: the packages of `moduleIds`, the production closure of `@mcs/web` when `includeWeb`, and the
 * embedded notices found in `bundleText`. Deduplicated, sorted, licence-checked.
 */
export function collectNotices({
  moduleIds,
  bundleText = '',
  includeWeb = true,
  lock = readJson(join(RUNTIME_ROOT, 'package-lock.json')),
  root = RUNTIME_ROOT,
  table = EMBEDDED_NOTICES,
}) {
  const keys = new Set();
  for (const id of moduleIds) {
    const key = packageKeyOf(id, root);
    if (key !== null) keys.add(key);
  }
  if (includeWeb) for (const key of productionClosure(lock, 'packages/web')) keys.add(key);
  const byId = new Map();
  for (const notice of [...[...keys].map((key) => noticeOf(lock, key, root)), ...embeddedNotices(bundleText, table)]) {
    byId.set(`${notice.name}@${notice.version}`, notice);
  }
  const notices = [...byId.values()].sort(compareNotices);
  assertAllowed(notices);
  return notices;
}

/** The text of `THIRD-PARTY-NOTICES.txt`: LF only, no dates, one block per package in the order given. */
export function renderNotices(notices) {
  const rule = '-'.repeat(78);
  const lines = [
    'THIRD-PARTY NOTICES',
    '',
    'The bundled files of this folder (mcs-cli.mjs, mcs-server.mjs, mcs-hook.mjs and web/) contain code of the following',
    'third-party packages. Each package is listed with its version, its SPDX licence id and its licence text.',
  ];
  for (const n of notices) {
    lines.push('', rule, `${n.name} ${n.version}`, `License: ${n.license}`, '');
    lines.push(n.text === null ? NO_LICENSE_FILE_MARKER : n.text);
  }
  return `${lines.join('\n')}\n`;
}
