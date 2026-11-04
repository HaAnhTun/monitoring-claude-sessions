// Display preferences in localStorage (04 section 9, ADR 0036). Every access is wrapped: storage may be missing, blocked,
// full or corrupt and the page must still work without it. Only non-sensitive display state is stored (theme, density,
// filters). This is the only module of the web package that touches web storage (ESLint no-restricted-globals).
import type { EntryKind } from '@mcs/shared';

/** The v3 key. The legacy key is read once for the migration and never written (the legacy UI may share the origin). */
export const PREFS_KEY = 'mcs.ui.v3';
export const LEGACY_PREFS_KEY = 'ccm.prefs.v1';

const KIND_NAMES: readonly string[] = ['prompt', 'say', 'think', 'tool', 'result'];

export interface PrefsData {
  theme: 'auto' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  newestFirst: boolean;
  showAll: boolean;
  /** Sidebar filter text, display only, at most 400 characters. */
  filter: string;
  kinds: Partial<Record<EntryKind, boolean>>;
  /** Collapsed state of disclosure groups by key. */
  collapsed: Record<string, boolean>;
  navOpen: boolean;
  lastInstanceId: string;
  /** The UI language (ADR 0072): `auto` follows the browser languages. */
  locale: 'auto' | 'en' | 'vi';
  /** The columns a user chose per table, by table id (ADR 0073). The ids are the column ids of the table. */
  tableColumns: Record<string, string[]>;
}

export type PrefName = keyof PrefsData;

type Validators = { readonly [K in PrefName]: (v: unknown) => v is PrefsData[K] };

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStr =
  (max: number) =>
  (v: unknown): v is string =>
    typeof v === 'string' && v.length <= max;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TABLE_LIMIT = 30;
const COLUMNS_LIMIT = 40;
const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v) && !UNSAFE_KEYS.has(v);

function isTableColumns(v: unknown): v is PrefsData['tableColumns'] {
  if (!isRecord(v)) return false;
  const entries = Object.entries(v);
  return (
    entries.length <= TABLE_LIMIT &&
    entries.every(
      ([table, columns]) =>
        isId(table) && Array.isArray(columns) && columns.length <= COLUMNS_LIMIT && columns.every(isId),
    )
  );
}

const VALIDATORS: Validators = {
  theme: (v): v is PrefsData['theme'] => v === 'auto' || v === 'light' || v === 'dark',
  density: (v): v is PrefsData['density'] => v === 'comfortable' || v === 'compact',
  newestFirst: isBool,
  showAll: isBool,
  filter: isStr(400),
  kinds: (v): v is PrefsData['kinds'] =>
    isRecord(v) && Object.entries(v).every(([k, value]) => KIND_NAMES.includes(k) && isBool(value)),
  collapsed: (v): v is PrefsData['collapsed'] =>
    isRecord(v) && Object.keys(v).length < 50 && Object.values(v).every(isBool),
  navOpen: isBool,
  lastInstanceId: isStr(64),
  locale: (v): v is PrefsData['locale'] => v === 'auto' || v === 'en' || v === 'vi',
  tableColumns: isTableColumns,
};

const PREF_NAMES = Object.keys(VALIDATORS).filter((k): k is PrefName => Object.hasOwn(VALIDATORS, k));

function copyKnown<K extends PrefName>(out: Partial<Pick<PrefsData, K>>, raw: Record<string, unknown>, name: K): void {
  const value = raw[name];
  if (VALIDATORS[name](value)) out[name] = value;
}

/** Keeps only known keys whose values have the expected shape; everything else (including the legacy `sel`) is dropped. */
export function sanitize(raw: unknown): Partial<PrefsData> {
  const out: Partial<PrefsData> = {};
  if (!isRecord(raw)) return out;
  for (const name of PREF_NAMES) copyKnown(out, raw, name);
  return out;
}

/** The part of the Web Storage API that is used. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isStorageLike(v: unknown): v is StorageLike {
  return isRecord(v) ? typeof v['getItem'] === 'function' && typeof v['setItem'] === 'function' : false;
}

/** The page's localStorage, or null when it is missing or its access throws (blocked storage, private windows). */
export function safeLocalStorage(): StorageLike | null {
  try {
    const candidate: unknown = Reflect.get(globalThis, 'localStorage');
    return isStorageLike(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export interface Prefs {
  get<K extends PrefName>(name: K): PrefsData[K] | undefined;
  get<K extends PrefName>(name: K, fallback: PrefsData[K]): PrefsData[K];
  /** Validates, keeps the value in memory and tries to persist it; false when it was rejected or could not be written. */
  set<K extends PrefName>(name: K, value: PrefsData[K]): boolean;
  all(): Partial<PrefsData>;
  /**
   * Forgets every stored preference except the named ones and writes the result under this store's key only (the legacy key and
   * every other key of the page stay as they are). False when nothing could be written.
   */
  clear(keep?: readonly PrefName[]): boolean;
  /** False once storage was missing, corrupt or refused a write. */
  readonly persistent: boolean;
}

function readJson(storage: StorageLike, key: string): { found: boolean; value: unknown } {
  const raw = storage.getItem(key);
  if (raw === null || raw === '') return { found: false, value: null };
  const parsed: unknown = JSON.parse(raw);
  return { found: true, value: parsed };
}

export function createPrefs(storage: StorageLike | null, key: string = PREFS_KEY): Prefs {
  let data: Partial<PrefsData> = {};
  let persistent = storage !== null;
  let importLegacy = false;
  try {
    if (storage !== null) {
      const current = readJson(storage, key);
      data = sanitize(current.value);
      importLegacy = !current.found && key === PREFS_KEY;
    }
  } catch {
    data = {};
    persistent = false;
  }

  function flush(): boolean {
    if (storage === null) return false;
    try {
      storage.setItem(key, JSON.stringify(data));
      persistent = true;
      return true;
    } catch {
      persistent = false;
      return false;
    }
  }

  if (importLegacy && storage !== null) {
    // One-time import of the legacy preferences: shared fields only; the legacy key itself is never written.
    try {
      const legacy = sanitize(readJson(storage, LEGACY_PREFS_KEY).value);
      if (Object.keys(legacy).length > 0) {
        data = legacy;
        flush();
      }
    } catch {
      // a corrupt or unreadable legacy value is ignored
    }
  }

  function get<K extends PrefName>(name: K): PrefsData[K] | undefined;
  function get<K extends PrefName>(name: K, fallback: PrefsData[K]): PrefsData[K];
  function get<K extends PrefName>(name: K, fallback?: PrefsData[K]): PrefsData[K] | undefined {
    return data[name] ?? fallback;
  }

  return {
    get,
    set(name, value) {
      // the name is typed, but callers may still pass anything at run time
      if (!Object.hasOwn(VALIDATORS, name) || !VALIDATORS[name](value)) return false;
      const next: Partial<PrefsData> = { ...data };
      next[name] = value;
      data = next;
      return flush();
    },
    all: () => ({ ...data }),
    clear(keep = []) {
      const kept: Partial<PrefsData> = {};
      for (const name of keep) copyKnown(kept, data, name);
      data = kept;
      return flush();
    },
    get persistent() {
      return persistent;
    },
  };
}

export interface HashSelection {
  sid: string;
  agent: string;
}

/** "#sid=abc&agent=x" -> { sid, agent }. Anything else -> { sid: '', agent: '' }. Values are capped at 200 characters. */
export function parseHash(hash: string | null | undefined): HashSelection {
  try {
    const p = new URLSearchParams((hash ?? '').replace(/^#/, ''));
    return { sid: (p.get('sid') ?? '').slice(0, 200), agent: (p.get('agent') ?? '').slice(0, 200) };
  } catch {
    return { sid: '', agent: '' };
  }
}

export function buildHash(sel: HashSelection | null | undefined): string {
  if (sel === null || sel === undefined || sel.sid === '') return '';
  const p = new URLSearchParams();
  p.set('sid', sel.sid);
  if (sel.agent !== '') p.set('agent', sel.agent);
  return `#${p.toString()}`;
}
