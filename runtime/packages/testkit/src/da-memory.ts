// The DA memory fixture (design 03, section 3; design 08, section 2.7): the folder `<home>/.claude/memory` that the memory hook of
// the reference product writes, read by the folder list of the workspace. `<slug>/meta.json` holds one folder, `index.json` is a
// cache of all of them, `brain.md` and `action.md` hold prompts and answers verbatim and `*.key` must never be opened: the fixture
// can plant the canaries that prove a reader leaves them alone. JSON and Markdown only; no script is ever written.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANARY } from './canary.ts';

/** The reader opens no `meta.json` larger than this (design 03, section 3, rule 2). */
export const DA_META_MAX_BYTES = 512 * 1024;
/** The reader opens no `index.json` larger than this. */
export const DA_INDEX_MAX_BYTES = 1024 * 1024;

const STALE_INDEX_MS = 2 * 60 * 60 * 1000;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** `<home>/.claude/memory`: where the hook writes, even when `CLAUDE_CONFIG_DIR` points elsewhere. */
export function daMemoryDir(home: string): string {
  return join(home, '.claude', 'memory');
}

/** The slug of a path: every run of characters outside `[A-Za-z0-9]` becomes one dash (a DA slug is not a Claude project key). */
export function daSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '-');
}

/** The timestamps of the hook are naive local time: `%Y-%m-%dT%H:%M:%S`. */
export function daTimestamp(ms: number): string {
  const at = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  const date = `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return `${date}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** How a folder's `meta.json` is written. */
export type DaMetaMode =
  /** An object with the fields of the hook. */
  | 'valid'
  /** A valid object cut off in the middle. */
  | 'invalid-json'
  /** A valid object behind a UTF-8 byte order mark. */
  | 'bom'
  /** A valid object larger than the cap of the reader. */
  | 'oversize'
  /** Valid JSON that is not an object. */
  | 'not-object'
  /** No `meta.json`: the folder exists, and only the index knows it. */
  | 'missing';

export interface DaFolderSpec {
  /** `meta.path` as the hook wrote it: any spelling (`D:\x`, `d:/x/`, `/mnt/d/x`, quoted). */
  readonly path: string;
  /** Name of the folder; default `daSlug(path)`. */
  readonly slug?: string;
  /** `last_updated` is `nowMs - ageMs` (default 0), also the modification time of `meta.json`. */
  readonly ageMs?: number;
  /** A literal `last_updated` (or `null`) instead of the one made from `ageMs`. */
  readonly lastUpdated?: string | null;
  readonly created?: string;
  /** Default `brain`. */
  readonly lastKind?: string;
  /** Default `FIXTURE summary <slug>`. */
  readonly summary?: string;
  /** Default `active`. */
  readonly status?: string;
  /** Default 1 and 1. */
  readonly counts?: { readonly brain: number; readonly action: number };
  /** Default none; the reader drops the array, so a canary can live in it. */
  readonly sessions?: readonly unknown[];
  /** Writes `brain.md` with this text. */
  readonly brainText?: string;
  /** Writes `action.md` with this text. */
  readonly actionText?: string;
  /** Default `valid`. */
  readonly meta?: DaMetaMode;
  /** Top-level fields of `meta.json` to leave out. */
  readonly omit?: readonly string[];
  /** Whether the folder is listed in `index.json` (default true). */
  readonly inIndex?: boolean;
}

export interface DaMemorySpec {
  /** The reference time: ages count back from it. */
  readonly nowMs: number;
  readonly folders: readonly DaFolderSpec[];
  /**
   * `fresh` (default) lists every folder; `stale` is two hours old, ages the entries and lists a folder that is gone;
   * `missing` writes no `index.json`; `invalid` writes text that is not JSON.
   */
  readonly index?: 'fresh' | 'stale' | 'missing' | 'invalid';
  /** Plants the canaries: `brain.md`, `action.md` and the `sessions` array of every folder (unless the folder gives its own). */
  readonly canary?: boolean;
  /** Writes `session.key` with the key canary into every folder. */
  readonly keyDecoys?: boolean;
}

export interface DaMemoryFixture {
  readonly dir: string;
  /** The folder names, in the order of the specs. */
  readonly slugs: readonly string[];
  metaPath(slug: string): string;
  readonly indexPath: string;
}

function touch(path: string, ms: number): void {
  const at = new Date(ms);
  utimesSync(path, at, at);
}

function checkSlug(slug: string): void {
  if (slug === '' || slug === '.' || slug === '..' || /[\\/]/.test(slug)) {
    throw new RangeError(`writeDaMemory: '${slug}' is not a plain folder name`);
  }
}

interface Resolved {
  readonly spec: DaFolderSpec;
  readonly slug: string;
  readonly mtimeMs: number;
  readonly lastUpdated: string | null;
  readonly summary: string;
  readonly status: string;
  readonly counts: { readonly brain: number; readonly action: number };
}

function resolveFolder(spec: DaFolderSpec, nowMs: number): Resolved {
  const slug = spec.slug ?? daSlug(spec.path);
  checkSlug(slug);
  const mtimeMs = nowMs - (spec.ageMs ?? 0);
  return {
    spec,
    slug,
    mtimeMs,
    lastUpdated: spec.lastUpdated === undefined ? daTimestamp(mtimeMs) : spec.lastUpdated,
    summary: spec.summary ?? `FIXTURE summary ${slug}`,
    status: spec.status ?? 'active',
    counts: spec.counts ?? { brain: 1, action: 1 },
  };
}

function metaObject(folder: Resolved, nowMs: number, canary: boolean): Record<string, unknown> {
  const { spec } = folder;
  const sessions = spec.sessions ?? (canary ? [{ id: 'FIXTURE-session', first: CANARY.thinking }] : []);
  const meta: Record<string, unknown> = {
    path: spec.path,
    slug: folder.slug,
    created: spec.created ?? folder.lastUpdated ?? daTimestamp(nowMs - (spec.ageMs ?? 0)),
    last_updated: folder.lastUpdated,
    last_kind: spec.lastKind ?? 'brain',
    counts: folder.counts,
    sessions: spec.meta === 'oversize' ? [...sessions, 'x'.repeat(DA_META_MAX_BYTES)] : sessions,
    summary: folder.summary,
    status: folder.status,
  };
  for (const key of spec.omit ?? []) Reflect.deleteProperty(meta, key);
  return meta;
}

function metaBytes(folder: Resolved, nowMs: number, canary: boolean): Buffer | null {
  const mode = folder.spec.meta ?? 'valid';
  if (mode === 'missing') return null;
  if (mode === 'not-object') return Buffer.from('[1, 2, 3]\n');
  const json = `${JSON.stringify(metaObject(folder, nowMs, canary), null, 2)}\n`;
  if (mode === 'invalid-json') return Buffer.from(json.slice(0, Math.floor(json.length / 2)));
  if (mode === 'bom') return Buffer.concat([BOM, Buffer.from(json)]);
  return Buffer.from(json);
}

function indexEntry(folder: Resolved, stale: boolean, nowMs: number): Record<string, unknown> {
  const age = folder.spec.ageMs ?? 0;
  const lastUpdated =
    stale && folder.spec.lastUpdated === undefined ? daTimestamp(nowMs - age - STALE_INDEX_MS) : folder.lastUpdated;
  return {
    slug: folder.slug,
    path: folder.spec.path,
    last_updated: lastUpdated,
    summary: folder.summary,
    status: folder.status,
    counts: folder.counts,
  };
}

/** Writes the memory folder `dir` (see `daMemoryDir`) and returns where things are. No marker file is written into it: every entry is a candidate for the reader. */
export function writeDaMemory(dir: string, spec: DaMemorySpec): DaMemoryFixture {
  const { nowMs } = spec;
  const canary = spec.canary === true;
  const folders = spec.folders.map((folder) => resolveFolder(folder, nowMs));
  const seen = new Set<string>();
  for (const { slug } of folders) {
    const key = slug.toLowerCase();
    if (seen.has(key)) throw new Error(`writeDaMemory: two folders with the slug '${slug}' (compared without case)`);
    seen.add(key);
  }
  mkdirSync(dir, { recursive: true });
  for (const folder of folders) {
    const folderDir = join(dir, folder.slug);
    mkdirSync(folderDir, { recursive: true });
    const bytes = metaBytes(folder, nowMs, canary);
    if (bytes !== null) {
      const file = join(folderDir, 'meta.json');
      writeFileSync(file, bytes);
      touch(file, folder.mtimeMs);
    }
    const brain = folder.spec.brainText ?? (canary ? `# brain\n${CANARY.prompt}\n` : undefined);
    if (brain !== undefined) writeFileSync(join(folderDir, 'brain.md'), brain);
    const action = folder.spec.actionText ?? (canary ? `# action\n${CANARY.toolResult}\n` : undefined);
    if (action !== undefined) writeFileSync(join(folderDir, 'action.md'), action);
    if (spec.keyDecoys === true) writeFileSync(join(folderDir, 'session.key'), CANARY.key);
    touch(folderDir, folder.mtimeMs);
  }
  const indexPath = join(dir, 'index.json');
  const mode = spec.index ?? 'fresh';
  if (mode !== 'missing') {
    if (mode === 'invalid') {
      writeFileSync(indexPath, '{"updated": "not finished", "folders": [');
    } else {
      const stale = mode === 'stale';
      const listed = folders
        .filter((folder) => folder.spec.inIndex !== false)
        .map((folder) => indexEntry(folder, stale, nowMs));
      if (stale) {
        listed.push({
          slug: 'FIXTURE-da-ghost',
          path: 'D:\\FIXTURE-da\\ghost',
          last_updated: daTimestamp(nowMs - STALE_INDEX_MS),
          summary: 'FIXTURE summary of a folder that is gone',
          status: 'active',
          counts: { brain: 1, action: 1 },
        });
      }
      const updated = daTimestamp(stale ? nowMs - STALE_INDEX_MS : nowMs);
      writeFileSync(indexPath, `${JSON.stringify({ updated, folders: listed }, null, 2)}\n`);
    }
    touch(indexPath, nowMs);
  }
  return {
    dir,
    slugs: folders.map((folder) => folder.slug),
    metaPath: (slug) => join(dir, slug, 'meta.json'),
    indexPath,
  };
}

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const RLO = String.fromCharCode(0x202e);

/** The variants a reader of the memory folder has to survive (design 08, section 2.7), each as the folder specs that make it. */
export const DA_VARIANTS = {
  /** A path of the Linux subsystem, to be mapped to a drive. */
  wsl: () => [{ path: '/mnt/d/FIXTURE-da/wsl' }],
  /** The path in quotes, with a space. */
  quoted: () => [{ path: '"D:\\FIXTURE-da\\quoted dir"' }],
  /** A trailing separator. */
  'trailing-backslash': () => [{ path: 'D:\\FIXTURE-da\\trail\\' }],
  /** Two folders for one place: other case, other separators and a trailing separator, other times. */
  'case-duplicate': () => [
    { path: 'D:\\FIXTURE-da\\Case', ageMs: 60_000, counts: { brain: 2, action: 3 } },
    { path: 'D:/FIXTURE-da/case/', ageMs: 120_000, counts: { brain: 5, action: 7 } },
  ],
  /** Markup with an event handler, control characters and a right-to-left override in the summary. */
  'hostile-summary': () => [
    {
      path: 'D:\\FIXTURE-da\\hostile',
      summary: `<img src=x onerror=alert(1)> <script>alert(2)</script> ${BEL}${ESC}[31mred${NUL}${RLO}end`,
    },
  ],
  /** A summary of about 100 KB, with runs of spaces. */
  'big-summary': () => [{ path: 'D:\\FIXTURE-da\\big', summary: 'word  '.repeat(Math.ceil((100 * 1024) / 6)) }],
  /** Only `path` and `slug` are left of `meta.json`. */
  'missing-fields': () => [
    {
      path: 'D:\\FIXTURE-da\\missing-fields',
      omit: ['created', 'last_updated', 'last_kind', 'counts', 'sessions', 'summary', 'status'],
    },
  ],
  /** `meta.json` that is cut off. */
  'invalid-json': () => [{ path: 'D:\\FIXTURE-da\\invalid-json', meta: 'invalid-json' as const }],
  /** `meta.json` behind a byte order mark. */
  bom: () => [{ path: 'D:\\FIXTURE-da\\bom', meta: 'bom' as const }],
  /** `meta.json` that is a JSON array. */
  'not-object': () => [{ path: 'D:\\FIXTURE-da\\not-object', meta: 'not-object' as const }],
  /** `meta.json` without `path`. */
  'no-path': () => [{ path: 'D:\\FIXTURE-da\\no-path', omit: ['path'] }],
  /** `meta.json` over the cap of the reader. */
  oversize: () => [{ path: 'D:\\FIXTURE-da\\oversize', meta: 'oversize' as const }],
  /** A network share: starting a process there would send credentials to it. */
  unc: () => [{ path: '\\\\FIXTURE-host\\share\\dir' }],
  /** A folder name that is not a slug the reader accepts (it has spaces). */
  'odd-slug': () => [{ path: 'D:\\FIXTURE-da\\odd', slug: 'FIXTURE odd name' }],
} as const satisfies Record<string, () => readonly DaFolderSpec[]>;

export type DaVariant = keyof typeof DA_VARIANTS;

/** The folder specs of one variant, ready for `writeDaMemory`. */
export function daVariantFolders(variant: DaVariant): DaFolderSpec[] {
  return [...DA_VARIANTS[variant]()];
}
