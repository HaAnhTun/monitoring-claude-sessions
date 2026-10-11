// Display preferences in localStorage. Every access is wrapped: storage may be
// missing, blocked, full or corrupt, and the page must still work without it.
// Only non-sensitive display state is stored (theme, density, filters, selected session id).

const KEY = 'ccm.prefs.v1';
const KIND_NAMES = ['prompt', 'say', 'think', 'tool', 'result'];

const isBool = (v) => typeof v === 'boolean';
const isStr = (v, max = 400) => typeof v === 'string' && v.length <= max;

const VALIDATORS = {
  theme: (v) => ['auto', 'light', 'dark'].includes(v),
  density: (v) => ['comfortable', 'compact'].includes(v),
  newestFirst: isBool,
  showAll: isBool,
  filter: (v) => isStr(v),
  kinds: (v) => v && typeof v === 'object' && Object.keys(v).every((k) => KIND_NAMES.includes(k) && isBool(v[k])),
  collapsed: (v) => v && typeof v === 'object' && Object.keys(v).length < 50 && Object.values(v).every(isBool),
  sel: (v) => v && typeof v === 'object' && isStr(v.sid, 200) && isStr(v.agent ?? '', 200),
};

/** Keep only known keys whose values have the expected type. */
export function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, ok] of Object.entries(VALIDATORS)) {
    if (k in raw && ok(raw[k])) out[k] = raw[k];
  }
  return out;
}

export function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function createPrefs(storage, key = KEY) {
  let data = {};
  let persistent = !!storage;
  try {
    const raw = storage ? storage.getItem(key) : null;
    data = sanitize(raw ? JSON.parse(raw) : {});
  } catch {
    data = {};
    persistent = false;
  }
  function flush() {
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify(data));
      persistent = true;
      return true;
    } catch {
      persistent = false;
      return false;
    }
  }
  return {
    get(name, fallback) {
      return name in data ? data[name] : fallback;
    },
    set(name, value) {
      if (!(name in VALIDATORS) || !VALIDATORS[name](value)) return false;
      data = { ...data, [name]: value };
      return flush();
    },
    all: () => ({ ...data }),
    get persistent() { return persistent; },
  };
}

/** "#sid=abc&agent=x" -> { sid, agent }. Anything else -> { sid: '', agent: '' }. */
export function parseHash(hash) {
  try {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    return { sid: (p.get('sid') || '').slice(0, 200), agent: (p.get('agent') || '').slice(0, 200) };
  } catch {
    return { sid: '', agent: '' };
  }
}

export function buildHash(sel) {
  if (!sel || !sel.sid) return '';
  const p = new URLSearchParams();
  p.set('sid', sel.sid);
  if (sel.agent) p.set('agent', sel.agent);
  return `#${p.toString()}`;
}
