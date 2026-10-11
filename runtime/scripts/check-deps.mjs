// Dependency hygiene gate (ADR-0041): exact pins, one shared version, and every import declared
// in the importing package (hoisting would otherwise hide a missing declaration).
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative, sep } from 'node:path';

import { PACKAGES, RUNTIME_ROOT, readJson } from './lib.mjs';

const problems = [];
const root = readJson(join(RUNTIME_ROOT, 'package.json'));
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ALIAS_EXACT = /^npm:[@a-z0-9/._-]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const BUILTINS = new Set(builtinModules);
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function checkExact(owner, deps) {
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (!EXACT.test(spec) && !ALIAS_EXACT.test(spec))
      problems.push(`${owner}: ${name}@${spec} is not an exact version`);
  }
}

function packageOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  return BUILTINS.has(name) ? null : name;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield full;
  }
}

checkExact('package.json devDependencies', root.devDependencies);
checkExact('package.json dependencies', root.dependencies);
const overrideKeys = Object.keys(root.overrides ?? {});
if (overrideKeys.join(',') !== 'eslint-plugin-jsx-a11y') {
  problems.push(
    `package.json overrides must contain only eslint-plugin-jsx-a11y (ADR-0042), found: ${overrideKeys.join(',')}`,
  );
}

const rootDev = new Set(Object.keys(root.devDependencies ?? {}));
for (const pkg of PACKAGES) {
  const dir = join(RUNTIME_ROOT, 'packages', pkg);
  const manifest = readJson(join(dir, 'package.json'));
  const where = `packages/${pkg}/package.json`;
  if (manifest.version !== root.version) problems.push(`${where}: version ${manifest.version} != root ${root.version}`);
  if (manifest.private !== true) problems.push(`${where}: must be private`);
  checkExact(where, manifest.dependencies);
  checkExact(where, manifest.devDependencies);
  for (const [name, spec] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (name.startsWith('@mcs/') && spec !== root.version)
      problems.push(`${where}: ${name}@${spec} must equal ${root.version}`);
  }
  const prod = new Set(Object.keys(manifest.dependencies ?? {}));
  const dev = new Set(Object.keys(manifest.devDependencies ?? {}));
  for (const file of walk(dir)) {
    const rel = relative(RUNTIME_ROOT, file).split(sep).join('/');
    const isTest =
      /\.test\.tsx?$/.test(rel) ||
      rel.includes('/test/') ||
      rel.includes('/e2e/') ||
      rel.endsWith('test-setup.ts') ||
      rel.endsWith('.config.ts');
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      const name = packageOf(specifier);
      if (name === null || name === manifest.name) continue;
      const typeOnly = /^\s*(import|export)\s+type\s/.test(match[0].trim());
      const declared = prod.has(name) || (isTest || typeOnly ? dev.has(name) || rootDev.has(name) : false);
      if (!declared) {
        problems.push(
          `${rel}: imports '${name}' which is not declared in ${isTest ? 'dependencies/devDependencies' : 'dependencies'} of ${where}`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`check-deps: ${p}`);
  console.error(`check-deps: ${problems.length} problem(s)`);
  process.exitCode = 1;
} else {
  console.log('check-deps: ok');
}
