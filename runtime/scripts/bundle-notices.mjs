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
 * The v2 line of the MCP SDK (`@modelcontextprotocol/server`) inlines Ajv, its format and helper libraries and `content-type`; the
 * v1 package of ADR 0060 does not, so with it these entries stay in place and never match.
 */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The version of `name` that the installed v2 line of the MCP SDK (`@modelcontextprotocol/server`) pre-bundles into its own dist
 * files, read from the module comments of those files; `fallback` when that package is not installed (with the literal v1 package
 * `@modelcontextprotocol/sdk` the libraries below are separate packages of the lockfile closure and are never matched).
 */
function inlinedVersion(name, fallback, root = RUNTIME_ROOT) {
  const dist = join(root, 'node_modules', '@modelcontextprotocol', 'server', 'dist');
  if (!existsSync(dist)) return fallback;
  const pattern = new RegExp(`/\\.pnpm/${escapeRegExp(name)}@(\\d+\\.\\d+\\.\\d+)/`);
  for (const file of readdirSync(dist)
    .filter((n) => n.endsWith('.mjs'))
    .sort()) {
    const match = pattern.exec(readFileSync(join(dist, file), 'utf8'));
    if (match !== null) return match[1];
  }
  return fallback;
}

/**
 * One entry of `EMBEDDED_NOTICES`. The pattern matches the bundle text when the code identified by `signature` is present and no
 * module of the package itself was bundled (rolldown writes a `//#region .../npm/<name>/...` line for each module of a separate
 * package), so a package that is part of the lockfile closure is never listed twice.
 */
function vendored({ name, fallbackVersion, license, signature, text }) {
  const own = `//#region (?:[^\\n]*/)?npm/${escapeRegExp(name)}/`;
  return {
    name,
    version: inlinedVersion(name, fallbackVersion),
    license,
    text,
    pattern: new RegExp(`^(?![\\s\\S]*${own})[\\s\\S]*?(?:${signature.source})`),
  };
}

export const EMBEDDED_NOTICES = Object.freeze([
  vendored({
    name: 'ajv',
    fallbackVersion: '8.18.0',
    license: 'MIT',
    signature: /CodeGen: name must be a valid identifier/,
    text: [
      'The MIT License (MIT)',
      '',
      'Copyright (c) 2015-2021 Evgeny Poberezkin',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
    ].join('\n'),
  }),
  vendored({
    name: 'ajv-formats',
    fallbackVersion: '3.0.1',
    license: 'MIT',
    signature: /exports\.fullFormats\s*=/,
    text: [
      'MIT License',
      '',
      'Copyright (c) 2020 Evgeny Poberezkin',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
    ].join('\n'),
  }),
  vendored({
    name: 'content-type',
    fallbackVersion: '1.0.5',
    license: 'MIT',
    signature: /var PARAM_REGEXP\s*=/,
    text: [
      '(The MIT License)',
      '',
      'Copyright (c) 2015 Douglas Christopher Wilson',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining',
      'a copy of this software and associated documentation files (the',
      "'Software'), to deal in the Software without restriction, including",
      'without limitation the rights to use, copy, modify, merge, publish,',
      'distribute, sublicense, and/or sell copies of the Software, and to',
      'permit persons to whom the Software is furnished to do so, subject to',
      'the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be',
      'included in all copies or substantial portions of the Software.',
      '',
      "THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,",
      'EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF',
      'MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
      'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY',
      'CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,',
      'TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE',
      'SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    ].join('\n'),
  }),
  vendored({
    name: 'fast-deep-equal',
    fallbackVersion: '3.1.3',
    license: 'MIT',
    signature: /module\.exports = function equal\(a, b\)/,
    text: [
      'MIT License',
      '',
      'Copyright (c) 2017 Evgeny Poberezkin',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
    ].join('\n'),
  }),
  vendored({
    name: 'fast-uri',
    fallbackVersion: '3.1.0',
    license: 'BSD-3-Clause',
    signature: /const supportedSchemeNames\s*=/,
    text: [
      'Copyright (c) 2011-2021, Gary Court until https://github.com/garycourt/uri-js/commit/a1acf730b4bba3f1097c9f52e7d9d3aba8cdcaae',
      'Copyright (c) 2021-present The Fastify team <https://github.com/fastify/fastify#team>',
      'All rights reserved.',
      '',
      'Redistribution and use in source and binary forms, with or without',
      'modification, are permitted provided that the following conditions are met:',
      '    * Redistributions of source code must retain the above copyright',
      '      notice, this list of conditions and the following disclaimer.',
      '    * Redistributions in binary form must reproduce the above copyright',
      '      notice, this list of conditions and the following disclaimer in the',
      '      documentation and/or other materials provided with the distribution.',
      '    * The names of any contributors may not be used to endorse or promote',
      '      products derived from this software without specific prior written',
      '      permission.',
      '',
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND',
      'ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED',
      'WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE',
      'DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS AND CONTRIBUTORS BE LIABLE FOR ANY',
      'DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES',
      '(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;',
      'LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND',
      'ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT',
      '(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS',
      'SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
      '',
      '                                  *   *   *',
      '',
      'The complete list of contributors can be found at:',
      '- https://github.com/garycourt/uri-js/graphs/contributors',
    ].join('\n'),
  }),
  vendored({
    name: 'json-schema-traverse',
    fallbackVersion: '1.0.0',
    license: 'MIT',
    signature: /traverse\.skipKeywords\s*=/,
    text: [
      'MIT License',
      '',
      'Copyright (c) 2017 Evgeny Poberezkin',
      '',
      'Permission is hereby granted, free of charge, to any person obtaining a copy',
      'of this software and associated documentation files (the "Software"), to deal',
      'in the Software without restriction, including without limitation the rights',
      'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
      'copies of the Software, and to permit persons to whom the Software is',
      'furnished to do so, subject to the following conditions:',
      '',
      'The above copyright notice and this permission notice shall be included in all',
      'copies or substantial portions of the Software.',
      '',
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
      'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
      'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
      'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
      'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
      'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
      'SOFTWARE.',
    ].join('\n'),
  }),
]);

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
