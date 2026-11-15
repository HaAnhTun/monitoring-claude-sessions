// The catalog of the Claude home folders (CAW design 03 section 4.2): what the folder list knows about `<claude home>/projects`.
// One entry per project folder with its key, the root folder it was made from, and whether that root still exists.
//
// A scan lists the folders (`listProjectFolders`: one `readdir`, one `lstat` per folder, links never entered). A folder whose
// modification time did not change keeps its entry, so it costs that one `lstat` and nothing else; a new or changed folder gets
// its root resolved (`readProjectRoot`, then `reverseProjectName`). `exists` is the `lstat` of the root and is refreshed on its own
// slower clock, not per request. Only paths are kept, never a line of a transcript; nothing is logged.
import { mapLimit, nodeDiscoveryFs, type DiscoveryFs } from '../ingest/transcripts/discovery.ts';
import { listProjectFolders, type ProjectFolder } from '../ingest/transcripts/discover-projects.ts';
import { hostPlatform } from '../platform/host.ts';
import { readProjectRoot, reverseProjectName } from './project-root.ts';

/** Folders listed at most (the merge caps the final list on its own). */
export const CATALOG_MAX_FOLDERS = 2000;
/** How long a known `exists` is trusted for a folder that did not change. */
export const CATALOG_EXISTS_RECHECK_MS = 120_000;
/** Folders whose root is resolved together. */
const RESOLVE_PARALLEL = 8;

export interface CatalogEntry {
  /** The folder name below `<claude home>/projects`, as Claude wrote it. */
  readonly dirName: string;
  /** The lower-cased folder name: the key of the project. */
  readonly key: string;
  readonly dirMtimeMs: number;
  readonly root: string | null;
  readonly rootSource: 'transcript' | 'reverse' | null;
  /** The root is a folder right now; null when no root is known. */
  readonly exists: boolean | null;
}

export interface CatalogStatus {
  readonly state: 'ok' | 'absent' | 'unreadable';
  /** The time of the last scan (the `now` of the catalog); null before the first. */
  readonly scannedAt: number | null;
  /** More folders than `maxFolders` exist; the oldest were left out. */
  readonly truncated: boolean;
}

export interface ProjectCatalog {
  /** Scans now, then every interval. Safe to call twice. */
  start(): void;
  /** Stops the timer and waits for a scan that is running. */
  stop(): Promise<void>;
  /** One scan; concurrent calls share it. Never rejects. */
  refresh(): Promise<void>;
  /** The entries of the last scan, newest folder first. */
  entries(): readonly CatalogEntry[];
  status(): CatalogStatus;
}

export interface CatalogOptions {
  readonly projectsRoot: string;
  readonly fs?: DiscoveryFs;
  readonly intervalMs: number;
  readonly now: () => number;
  /** Which spelling of a path is valid (default: the host). */
  readonly win32?: boolean;
  readonly maxFolders?: number;
  readonly existsRecheckMs?: number;
}

interface Cached {
  readonly entry: CatalogEntry;
  /** When `exists` was looked at. */
  readonly existsAt: number;
}

export function createProjectCatalog(options: CatalogOptions): ProjectCatalog {
  const fs = options.fs ?? nodeDiscoveryFs;
  const win32 = options.win32 ?? hostPlatform === 'win32';
  const maxFolders = options.maxFolders ?? CATALOG_MAX_FOLDERS;
  const recheckMs = options.existsRecheckMs ?? CATALOG_EXISTS_RECHECK_MS;
  let cache = new Map<string, Cached>();
  let list: readonly CatalogEntry[] = [];
  let state: CatalogStatus = { state: 'ok', scannedAt: null, truncated: false };
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function present(target: string): Promise<boolean> {
    try {
      return (await fs.lstat(target)) !== null;
    } catch {
      return false;
    }
  }

  async function rootExists(root: string): Promise<boolean> {
    try {
      return (await fs.lstat(root))?.kind === 'dir';
    } catch {
      return false;
    }
  }

  async function rootOf(folder: ProjectFolder): Promise<Pick<CatalogEntry, 'root' | 'rootSource'>> {
    try {
      const sniffed = await readProjectRoot(fs, folder.dir, { win32 });
      if (sniffed !== null) return { root: sniffed.root, rootSource: sniffed.source };
      const decoded = await reverseProjectName(folder.name, fs, { win32 });
      return decoded === null ? { root: null, rootSource: null } : { root: decoded, rootSource: 'reverse' };
    } catch {
      return { root: null, rootSource: null };
    }
  }

  async function resolve(folder: ProjectFolder, nowMs: number): Promise<Cached> {
    const { root, rootSource } = await rootOf(folder);
    const exists = root === null ? null : await rootExists(root);
    return {
      entry: {
        dirName: folder.name,
        key: folder.name.toLowerCase(),
        dirMtimeMs: folder.mtimeMs,
        root,
        rootSource,
        exists,
      },
      existsAt: nowMs,
    };
  }

  async function refreshExists(cached: Cached, nowMs: number): Promise<Cached> {
    const { root } = cached.entry;
    if (root === null || nowMs - cached.existsAt < recheckMs) return cached;
    return { entry: { ...cached.entry, exists: await rootExists(root) }, existsAt: nowMs };
  }

  async function scan(): Promise<void> {
    const nowMs = options.now();
    let folders: ProjectFolder[];
    let missing: boolean;
    try {
      const found = await listProjectFolders(options.projectsRoot, fs);
      folders = found.folders;
      missing = found.missing;
    } catch {
      cache = new Map();
      list = [];
      state = { state: 'unreadable', scannedAt: nowMs, truncated: false };
      return;
    }
    if (missing) {
      const exists = await present(options.projectsRoot);
      cache = new Map();
      list = [];
      state = { state: exists ? 'unreadable' : 'absent', scannedAt: nowMs, truncated: false };
      return;
    }
    const truncated = folders.length > maxFolders;
    const kept = truncated ? folders.slice(0, maxFolders) : folders;
    const next = new Map<string, Cached>();
    const resolved = await mapLimit(kept, RESOLVE_PARALLEL, async (folder) => {
      const known = cache.get(folder.name);
      if (known?.entry.dirMtimeMs === folder.mtimeMs) return refreshExists(known, nowMs);
      return resolve(folder, nowMs);
    });
    resolved.forEach((cached) => next.set(cached.entry.dirName, cached));
    cache = next;
    list = resolved.map((cached) => cached.entry);
    state = { state: 'ok', scannedAt: nowMs, truncated };
  }

  function refresh(): Promise<void> {
    if (inFlight !== null) return inFlight;
    const run = scan()
      .catch(() => {
        cache = new Map();
        list = [];
        state = { state: 'unreadable', scannedAt: options.now(), truncated: false };
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  }

  return {
    start() {
      if (timer !== null) return;
      void refresh();
      timer = setInterval(() => {
        void refresh();
      }, options.intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight;
    },
    refresh,
    entries: () => list,
    status: () => state,
  };
}
