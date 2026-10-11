// Pure filter / search helpers over timeline units (see timeline-model.pairEvents).

export const KINDS = ['prompt', 'say', 'think', 'tool', 'result'];
export const KIND_LABELS = { prompt: 'Prompts', say: 'Claude', think: 'Thinking', tool: 'Tool calls', result: 'Results' };

export function defaultFilters(ui = {}) {
  return {
    q: '',
    tool: '',
    errorsOnly: false,
    kinds: {
      prompt: !!ui.show_prompts,
      say: true,
      think: !!ui.show_thinking,
      tool: ui.show_tools !== false,
      result: true,
    },
  };
}

const textCache = new WeakMap();
function evText(ev) {
  let t = textCache.get(ev);
  if (t === undefined) {
    t = [ev.text, ev.name, ev.summary, ev.input].filter((x) => typeof x === 'string').join('\n').toLowerCase();
    textCache.set(ev, t);
  }
  return t;
}

export function unitText(u) {
  return u.result ? `${evText(u.ev)}\n${evText(u.result)}` : evText(u.ev);
}

/** Does the unit pass the kind, tool, errors-only and text filters? */
export function unitVisible(u, f) {
  const hasResult = !!u.result;
  if (u.kind === 'tool') {
    if (!(f.kinds.tool || (f.kinds.result && hasResult))) return false;
    if (f.tool && u.ev.name !== f.tool) return false;
    if (f.errorsOnly && u.status !== 'failed') return false;
  } else if (u.kind === 'result') {
    if (!f.kinds.result) return false;
    if (f.tool) return false;
    if (f.errorsOnly && !u.ev.err) return false;
  } else {
    if (!f.kinds[u.kind]) return false;
    if (f.tool || f.errorsOnly) return false;
  }
  const q = (f.q || '').trim().toLowerCase();
  if (q && !unitText(u).includes(q)) return false;
  return true;
}

export function hasActiveFilters(f) {
  return !!((f.q || '').trim() || f.tool || f.errorsOnly);
}

/** Sorted distinct tool names from units. */
export function collectToolNames(units) {
  const s = new Set();
  for (const u of units) if (u.kind === 'tool' && u.ev.name) s.add(u.ev.name);
  return [...s].sort((a, b) => a.localeCompare(b));
}

/** Query string for /api/search that mirrors the current filters. */
export function searchQuery(f, sid, agent, limit = 200) {
  const p = new URLSearchParams();
  p.set('sid', sid);
  p.set('agent', agent || '');
  const q = (f.q || '').trim();
  if (q) p.set('q', q);
  const kinds = KINDS.filter((k) => f.kinds[k]);
  if (kinds.length && kinds.length < KINDS.length) p.set('kinds', kinds.join(','));
  if (f.tool) p.set('tool', f.tool);
  if (f.errorsOnly) p.set('errors', '1');
  p.set('limit', String(limit));
  return p.toString();
}
