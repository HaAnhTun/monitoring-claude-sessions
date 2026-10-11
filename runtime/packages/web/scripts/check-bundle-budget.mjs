// Bundle budget and index.html scan (04-ui.md section 12.3, ADR 0039). Run after `vite build` (the vite config calls it).
// Usage: node scripts/check-bundle-budget.mjs [--dist <dir>]   (default: ../dist next to this script)
// Exit 0 within budget, 1 over budget or malformed output, 2 when dist is missing.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1000;
export const LIMITS = {
  initialJs: 200 * KB,
  allJs: 260 * KB,
  css: 25 * KB,
};

function gzipSize(file) {
  return gzipSync(readFileSync(file), { level: 9 }).length;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Problems found in a built (or source) index.html text: inline script bodies, external URLs, script count. */
export function auditHtml(html) {
  const problems = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const isModule = (attrs) => /\btype\s*=\s*["']module["']/i.test(attrs);
  const modules = scripts.filter((m) => isModule(m[1]));
  const classic = scripts.filter((m) => !isModule(m[1]));
  if (scripts.some((m) => m[2].trim() !== '')) problems.push('index.html has an inline script body');
  if (modules.length !== 1) problems.push(`index.html must have exactly one module script, found ${modules.length}`);
  if (classic.length !== 1 || !/\bsrc\s*=\s*["']\/theme-init\.js["']/.test(classic[0][1])) {
    problems.push('index.html must have exactly one classic script, /theme-init.js');
  }
  if (/https?:\/\//i.test(html)) problems.push('index.html contains an http:// or https:// URL');
  return problems;
}

/** Entry chunk plus its static imports (not the dynamic ones), as manifest keys. */
function initialChunks(manifest) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key) || manifest[key] === undefined) return;
    seen.add(key);
    for (const next of manifest[key].imports ?? []) visit(next);
  };
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry === true) visit(key);
  }
  return [...seen].map((key) => manifest[key].file).filter((file) => file.endsWith('.js'));
}

export function checkBudget(distDir) {
  const dist = resolve(distDir);
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!existsSync(manifestPath))
    return { exitCode: 2, rows: [], problems: [`missing ${manifestPath}: run vite build first`] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = walk(dist).map((file) => relative(dist, file).split(sep).join('/'));

  const initialJs = initialChunks(manifest).reduce((sum, file) => sum + gzipSize(join(dist, file)), 0);
  const allJs = files.filter((f) => f.endsWith('.js')).reduce((sum, f) => sum + gzipSize(join(dist, f)), 0);
  const css = files.filter((f) => f.endsWith('.css')).reduce((sum, f) => sum + gzipSize(join(dist, f)), 0);

  const problems = [];
  const indexPath = join(dist, 'index.html');
  if (existsSync(indexPath)) problems.push(...auditHtml(readFileSync(indexPath, 'utf8')));
  else problems.push('dist/index.html is missing');
  for (const map of files.filter((f) => f.endsWith('.map'))) problems.push(`source map in dist: ${map}`);

  const rows = [
    { name: 'Initial JS (gzip)', size: initialJs, limit: LIMITS.initialJs },
    { name: 'All JS (gzip)', size: allJs, limit: LIMITS.allJs },
    { name: 'CSS total (gzip)', size: css, limit: LIMITS.css },
  ].map((row) => ({ ...row, ok: row.size <= row.limit }));

  const ok = rows.every((row) => row.ok) && problems.length === 0;
  return { exitCode: ok ? 0 : 1, rows, problems };
}

function formatKb(bytes) {
  return `${(bytes / KB).toFixed(1)} kB`;
}

function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--dist');
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = flag === -1 ? resolve(here, '..', 'dist') : resolve(args[flag + 1] ?? '');
  const { exitCode, rows, problems } = checkBudget(dist);
  for (const row of rows) {
    console.log(
      `${row.ok ? 'ok  ' : 'FAIL'} ${row.name.padEnd(20)} ${formatKb(row.size).padStart(10)} / ${formatKb(row.limit)}`,
    );
  }
  for (const problem of problems) console.log(`FAIL ${problem}`);
  if (exitCode !== 2) {
    writeFileSync(
      join(dist, 'build-report.json'),
      `${JSON.stringify({ rows: rows.map(({ name, size, limit, ok }) => ({ name, size, limit, ok })), problems }, null, 2)}\n`,
    );
  }
  process.exit(exitCode);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
