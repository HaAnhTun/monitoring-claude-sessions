// Bundle budget and index.html scan (04-ui.md section 12.3, ADR 0039; the terminal row and the xterm check: ADR 0097; the optional
// GPU chunk, its own row and the WebGL checks: ADR 0135).
// Run after `vite build` (the vite config calls it).
// Usage: node scripts/check-bundle-budget.mjs [--dist <dir>]   (default: ../dist next to this script)
// Exit 0 within budget, 1 over budget or malformed output, 2 when dist is missing.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const KB = 1000;
export const LIMITS = {
  initialJs: 200 * KB,
  // ADR 0071 decision 12 set 340 kB for all chunks, both locales, seven pages and one hand-drawn chart; ADR 0097 raises it to 420 for
  // the Workspace page and the lazy terminal chunk (xterm 6.0.0 and its two addons are about 85 kB of it). ADR 0135 retunes it to
  // 432 kB (428.0 kB measured) and takes the optional GPU chunk out of the sum: that chunk has its own row below, so the total allowed is
  // all JS plus the GPU cap.
  allJs: 432 * KB,
  // The terminal chunk (every file the terminal page and its loader reach that is not in the initial set and is not the GPU chunk):
  // xterm 6.0.0, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`, the loader and its shims, measured on a
  // fresh build (94.9 kB) plus 10 percent (ADR 0135; 94 kB was the limit before Unicode 11, ADR 0097)
  terminalJs: 105 * KB,
  // The optional WebGL renderer (`@xterm/addon-webgl` 0.19.0), a lazy chunk of its own that is fetched only when WebGL2 exists and the
  // preference is not "dom": 30.6 kB on a fresh build plus 10 percent (ADR 0135)
  terminalGpuJs: 34 * KB,
  // ADR 0097 raises it from 25 kB: xterm.css is in the initial CSS
  css: 30 * KB,
};

/**
 * The manifest keys of the files that open the terminal chunk: the terminal page (loaded lazily by the Workspace page) and the
 * loader (the only file that imports xterm). The page does not exist in a build that predates it; the loader then stands alone.
 */
export const TERMINAL_ENTRIES = ['src/terminal/TerminalView.tsx', 'src/terminal/xterm-loader.ts'];

/** A text that only xterm's own code carries (the class prefix of its DOM renderer): a chunk that holds it holds xterm. */
export const XTERM_MARKER = 'xterm-dom-renderer-owner';

/**
 * The module path that marks the GPU chunk in the manifest. The partition reads the manifest KEY (the module path), never the file
 * name: the bundler may name the chunk after anything.
 */
export const GPU_KEY = '/@xterm/addon-webgl/';

/** A text that only the WebGL addon carries (the event it listens to when the browser takes the GPU context away). */
export const WEBGL_MARKER = 'webglcontextlost';

/** What the server replaces with the style nonce of each HTML response (design 02 section 7, ADR 0086). */
const NONCE_PLACEHOLDER = '__CSP_NONCE__';

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

/** Problems found in a built (or source) index.html text: inline script bodies, external URLs, script count, the nonce tag. */
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
  // Without the tag the server has no place to put the nonce, xterm's style elements are blocked and the terminal draws unstyled.
  const nonceTags = [...html.matchAll(/<meta\b[^>]*>/gi)].filter((m) => /\bname\s*=\s*["']csp-nonce["']/i.test(m[0]));
  const placeholder = new RegExp(`\\bcontent\\s*=\\s*["']${NONCE_PLACEHOLDER}["']`, 'i');
  if (nonceTags.length !== 1 || !placeholder.test(nonceTags[0][0])) {
    problems.push(`index.html must carry <meta name="csp-nonce" content="${NONCE_PLACEHOLDER}"> exactly once`);
  }
  return problems;
}

/** Entry chunk plus its static imports (not the dynamic ones), as manifest keys. */
function initialKeys(manifest) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key) || manifest[key] === undefined) return;
    seen.add(key);
    for (const next of manifest[key].imports ?? []) visit(next);
  };
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isEntry === true) visit(key);
  }
  return seen;
}

/** The files of manifest keys, JavaScript only. */
function jsFiles(manifest, keys) {
  return [...keys].map((key) => manifest[key].file).filter((file) => file.endsWith('.js'));
}

/** Every manifest key reachable from `roots` through static and dynamic imports, never entering a key of `stop`. */
function reachableKeys(manifest, roots, stop) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key) || stop.has(key) || manifest[key] === undefined) return;
    seen.add(key);
    for (const next of [...(manifest[key].imports ?? []), ...(manifest[key].dynamicImports ?? [])]) visit(next);
  };
  for (const root of roots) visit(root);
  return seen;
}

/**
 * The keys of the pages that load a terminal entry lazily (the Workspace page) and every chunk they import statically: the first thing
 * the browser has fetched when the terminal chunk starts to load. The bundler leaves a module out of a shared chunk when the lazily
 * loaded terminal page can count on its importer, so the terminal page imports the page's own chunk and its shared chunks.
 */
function loaderKeys(manifest, roots) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key) || manifest[key] === undefined) return;
    seen.add(key);
    for (const next of manifest[key].imports ?? []) visit(next);
  };
  for (const [key, chunk] of Object.entries(manifest)) {
    if ((chunk.dynamicImports ?? []).some((next) => roots.includes(next))) visit(key);
  }
  return seen;
}

export function checkBudget(distDir) {
  const dist = resolve(distDir);
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!existsSync(manifestPath))
    return { exitCode: 2, rows: [], problems: [`missing ${manifestPath}: run vite build first`] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const files = walk(dist).map((file) => relative(dist, file).split(sep).join('/'));

  const initialSet = initialKeys(manifest);
  const initialFiles = jsFiles(manifest, initialSet);
  const initialJs = initialFiles.reduce((sum, file) => sum + gzipSize(join(dist, file)), 0);
  const css = files.filter((f) => f.endsWith('.css')).reduce((sum, f) => sum + gzipSize(join(dist, f)), 0);

  // The terminal chunk: what the terminal page and the loader can fetch, less what the first load fetches anyway and less what the
  // page that opens the terminal has fetched by then. The walk does not enter those keys (the entry's dynamic imports are every page).
  const terminalRoots = TERMINAL_ENTRIES.filter((key) => manifest[key] !== undefined);
  // The optional GPU chunk is partitioned out by manifest key: the terminal walk does not enter it, and it has a row of its own.
  const gpuKeys = new Set(Object.keys(manifest).filter((key) => key.includes(GPU_KEY)));
  const gpuFiles = jsFiles(manifest, gpuKeys).filter((file) => !initialFiles.includes(file));
  const alreadyFetched = new Set([...initialSet, ...loaderKeys(manifest, terminalRoots), ...gpuKeys]);
  const terminalFiles = jsFiles(manifest, reachableKeys(manifest, terminalRoots, alreadyFetched)).filter(
    (file) => !initialFiles.includes(file) && !gpuFiles.includes(file),
  );
  const terminalJs = terminalFiles.reduce((sum, file) => sum + gzipSize(join(dist, file)), 0);
  const gpuJs = gpuFiles.reduce((sum, file) => sum + gzipSize(join(dist, file)), 0);
  // all JS leaves the optional GPU chunk out (ADR 0135): it is fetched on some machines only and capped by its own row
  const allJs = files
    .filter((f) => f.endsWith('.js') && !gpuFiles.includes(f))
    .reduce((sum, f) => sum + gzipSize(join(dist, f)), 0);

  const problems = [];
  const indexPath = join(dist, 'index.html');
  if (existsSync(indexPath)) problems.push(...auditHtml(readFileSync(indexPath, 'utf8')));
  else problems.push('dist/index.html is missing');
  for (const map of files.filter((f) => f.endsWith('.map'))) problems.push(`source map in dist: ${map}`);

  // xterm in the first load: a terminal entry among the initial chunks, or an initial chunk that holds xterm's code
  const inInitial = new Set(terminalRoots.filter((key) => initialSet.has(key)).map((key) => manifest[key].file));
  for (const file of initialFiles) {
    if (readFileSync(join(dist, file), 'utf8').includes(XTERM_MARKER)) inInitial.add(file);
  }
  for (const file of [...inInitial].sort()) problems.push(`xterm is in the initial chunks: ${file}`);

  // The WebGL renderer must stay its own lazy chunk, else the GPU row means nothing and every machine pays for it: it is a problem in
  // an initial chunk, and in any other file outside the GPU partition (the terminal chunk).
  const initialWebgl = initialFiles.filter((file) => readFileSync(join(dist, file), 'utf8').includes(WEBGL_MARKER));
  for (const file of initialWebgl.sort()) problems.push(`the WebGL renderer is in the initial chunks: ${file}`);
  const otherWebgl = files
    .filter((f) => f.endsWith('.js') && !gpuFiles.includes(f) && !initialFiles.includes(f))
    .filter((file) => readFileSync(join(dist, file), 'utf8').includes(WEBGL_MARKER));
  for (const file of otherWebgl.sort()) problems.push(`the WebGL renderer is in the terminal chunk: ${file}`);

  const rows = [
    { name: 'Initial JS (gzip)', size: initialJs, limit: LIMITS.initialJs },
    { name: 'All JS (gzip)', size: allJs, limit: LIMITS.allJs },
    {
      name: 'Terminal chunk (gzip)',
      size: terminalJs,
      limit: LIMITS.terminalJs,
      ...(terminalRoots.length === 0 ? { note: 'no terminal entry in this build' } : {}),
    },
    {
      name: 'Terminal GPU chunk (gzip)',
      size: gpuJs,
      limit: LIMITS.terminalGpuJs,
      ...(gpuFiles.length === 0 ? { note: 'no GPU chunk in this build' } : {}),
    },
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
      `${row.ok ? 'ok  ' : 'FAIL'} ${row.name.padEnd(26)} ${formatKb(row.size).padStart(10)} / ${formatKb(row.limit)}${
        row.note === undefined ? '' : `  (${row.note})`
      }`,
    );
  }
  for (const problem of problems) console.log(`FAIL ${problem}`);
  if (exitCode !== 2) {
    writeFileSync(
      join(dist, 'build-report.json'),
      `${JSON.stringify(
        {
          rows: rows.map(({ name, size, limit, ok, note }) => ({
            name,
            size,
            limit,
            ok,
            ...(note === undefined ? {} : { note }),
          })),
          problems,
        },
        null,
        2,
      )}\n`,
    );
  }
  process.exit(exitCode);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
