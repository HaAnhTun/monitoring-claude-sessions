// Session list: grouping and filtering (pure) and rendering (DOM, textContent only).
import { el, icon, stateBadge, tagBadge, clear } from './dom.js';
import { fmtAge, fmtMB, tokenLine, usageBadge, plural } from './format.js';
import { normalizeState } from './health.js';

export const GROUPS = [
  { id: 'running', title: 'Running now', states: ['RUNNING'] },
  { id: 'idle', title: 'Idle', states: ['IDLE'] },
  { id: 'done', title: 'Completed & failed', states: ['COMPLETED', 'FAILED'] },
  { id: 'unknown', title: 'Unknown', states: ['UNKNOWN'] },
];
export const LAZY_AGENT_THRESHOLD = 30;
export const AGENT_PAGE = 100;

const lc = (v) => String(v ?? '').toLowerCase();

function sessionHaystack(s) {
  return [s.label, s.id, s.state, s.state_evidence].map(lc).join(' ');
}
function agentHaystack(a) {
  return [a.label, a.agent, a.workflow, a.model, a.state].map(lc).join(' ');
}

/**
 * Filter + group sessions. Returns [{id,title,entries:[{s, agents, viaAgents}]}] without empty groups.
 * A session whose own fields do not match but some agent does is kept with only those agents.
 */
export function buildSessionView(list, filterText = '') {
  const tokens = lc(filterText).split(/\s+/).filter(Boolean);
  const entries = [];
  for (const s of list) {
    const agents = Array.isArray(s.agents) ? s.agents : [];
    if (!tokens.length) { entries.push({ s, agents, viaAgents: false }); continue; }
    const sh = sessionHaystack(s);
    if (tokens.every((t) => sh.includes(t))) { entries.push({ s, agents, viaAgents: false }); continue; }
    const hit = agents.filter((a) => { const h = `${sh} ${agentHaystack(a)}`; return tokens.every((t) => h.includes(t)); });
    if (hit.length) entries.push({ s, agents: hit, viaAgents: true });
  }
  return GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    entries: entries.filter((e) => g.states.includes(normalizeState(e.s.state))),
  })).filter((g) => g.entries.length);
}

/** Group agents by workflow; plain subagents go under "Subagents". */
export function groupAgents(agents) {
  const map = new Map();
  for (const a of agents) {
    const name = a.workflow ? String(a.workflow) : '';
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(a);
  }
  const groups = [];
  if (map.has('')) groups.push({ name: '', title: 'Subagents', agents: map.get('') });
  for (const [name, list] of map) if (name) groups.push({ name, title: `Workflow ${name}`, agents: list });
  return groups.map((g) => ({ ...g, summary: stateSummary(g.agents) }));
}

/** "2 running, 5 completed" in a stable order. */
export function stateSummary(items) {
  const c = {};
  for (const it of items) { const s = normalizeState(it.state); c[s] = (c[s] || 0) + 1; }
  return ['RUNNING', 'IDLE', 'COMPLETED', 'FAILED', 'UNKNOWN']
    .filter((s) => c[s]).map((s) => `${c[s]} ${s.toLowerCase()}`).join(', ');
}

/** Map key -> state for every session and agent (used to announce changes). */
export function stateMap(list) {
  const m = new Map();
  for (const s of list) {
    m.set(`${s.id}|`, { state: normalizeState(s.state), label: s.label });
    for (const a of s.agents || []) m.set(`${s.id}|${a.agent}`, { state: normalizeState(a.state), label: `${s.label} / ${a.label}` });
  }
  return m;
}

export function diffStates(prev, next) {
  const changes = [];
  for (const [k, v] of next) {
    const p = prev.get(k);
    if (p && p.state !== v.state) changes.push({ key: k, label: v.label, from: p.state, to: v.state });
  }
  return changes;
}

// ---- rendering -----------------------------------------------------------------

function tokenBlock(usage, completeness) {
  const row = el('span', { cls: 'tokens mono', text: tokenLine(usage) });
  const wrap = el('span', { cls: 'meta-line' }, [row]);
  const b = usageBadge(usage, completeness);
  if (b) wrap.appendChild(tagBadge(b.kind, b.text, 'alert', b.tip));
  return wrap;
}

function evidence(item) {
  return item.state_evidence ? el('span', { cls: 'evidence', text: item.state_evidence }) : null;
}

function sessionButton(s, ctx) {
  const selected = ctx.selected.sid === s.id && !ctx.selected.agent;
  const state = normalizeState(s.state);
  const btn = el('button', {
    cls: `sess-btn${selected ? ' is-selected' : ''}`,
    attrs: { type: 'button', 'aria-current': selected ? 'true' : undefined, title: s.state_evidence || undefined, tabindex: -1 },
    data: { nav: '1', key: `s:${s.id}`, sid: s.id },
    on: { click: () => ctx.onSelect(s.id, '') },
  });
  btn.appendChild(el('span', { cls: 'row' }, [
    el('span', { cls: 'sess-label', text: s.label || s.id }),
    stateBadge(state, s.state_evidence),
  ]));
  const ev = evidence(s);
  if (ev) btn.appendChild(ev);
  const n = (s.agents || []).length;
  const meta = [fmtAge(s.age) ? `${fmtAge(s.age)} ago` : '', fmtMB(s.size), n ? plural(n, 'subagent') : ''].filter(Boolean).join(' · ');
  btn.appendChild(el('span', { cls: 'meta-line mono', text: meta }));
  if (s.pending_tools) btn.appendChild(el('span', { cls: 'meta-line' }, [icon('tool'), el('span', { text: `${plural(s.pending_tools, 'tool call')} without result` })]));
  btn.appendChild(tokenBlock(s.usage_total || s.usage, s.completeness));
  if (s.completeness && s.completeness.events === 'partial') btn.appendChild(el('span', { cls: 'meta-line' }, [tagBadge('partial', 'partial history', 'alert', 'Only the latest events are loaded for this session')]));
  return btn;
}

function agentButton(s, a, ctx) {
  const selected = ctx.selected.sid === s.id && ctx.selected.agent === a.agent;
  const btn = el('button', {
    cls: `agent-btn${selected ? ' is-selected' : ''}`,
    attrs: { type: 'button', 'aria-current': selected ? 'true' : undefined, title: a.state_evidence || undefined, tabindex: -1 },
    data: { nav: '1', key: `a:${s.id}:${a.agent}` },
    on: { click: () => ctx.onSelect(s.id, a.agent) },
  });
  const top = el('span', { cls: 'row' }, [el('span', { cls: 'sess-label', text: a.label || a.agent }), stateBadge(normalizeState(a.state), a.state_evidence)]);
  btn.appendChild(top);
  const ev = evidence(a);
  if (ev) btn.appendChild(ev);
  const meta = [fmtAge(a.age) ? `${fmtAge(a.age)} ago` : '', fmtMB(a.size), a.model || ''].filter(Boolean).join(' · ');
  btn.appendChild(el('span', { cls: 'meta-line mono', text: meta }));
  btn.appendChild(tokenBlock(a.usage, a.completeness));
  return btn;
}

function agentGroupKey(sid, name) { return `g:${sid}:${name}`; }

function renderAgentGroups(s, agents, ctx) {
  const total = agents.length;
  const wrap = el('div', { cls: 'agent-groups' });
  for (const g of groupAgents(agents)) {
    const key = agentGroupKey(s.id, g.name);
    const hasSel = ctx.selected.sid === s.id && g.agents.some((a) => a.agent === ctx.selected.agent);
    const override = ctx.groupState.get(key);
    const expanded = override !== undefined ? override : (hasSel || total <= LAZY_AGENT_THRESHOLD);
    const box = el('div', { cls: 'agent-group' });
    const head = el('button', {
      cls: 'grp-toggle',
      attrs: { type: 'button', 'aria-expanded': String(expanded) },
      data: { nav: '1', key },
      on: { click: () => ctx.onToggleGroup(key, !expanded) },
    }, [
      icon(expanded ? 'chevron-down' : 'chevron-right'),
      el('span', { cls: 'grp-title', text: g.title }),
      el('span', { cls: 'count', text: String(g.agents.length) }),
      el('span', { cls: 'grp-summary', text: g.summary }),
    ]);
    box.appendChild(head);
    if (expanded) {
      const shownKey = `${key}#shown`;
      const shown = Math.max(AGENT_PAGE, ctx.groupState.get(shownKey) || 0);
      const list = el('ul', { cls: 'plain agent-list' });
      for (const a of g.agents.slice(0, shown)) list.appendChild(el('li', {}, [agentButton(s, a, ctx)]));
      box.appendChild(list);
      if (g.agents.length > shown) {
        box.appendChild(el('button', {
          cls: 'btn btn-quiet', attrs: { type: 'button' }, data: { nav: '1', key: `${key}#more` },
          text: `Show ${Math.min(AGENT_PAGE, g.agents.length - shown)} more (${g.agents.length - shown} not shown)`,
          on: { click: () => ctx.onToggleGroup(shownKey, shown + AGENT_PAGE) },
        }));
      }
    }
    wrap.appendChild(box);
  }
  return wrap;
}

/**
 * ctx: {selected:{sid,agent}, groupState:Map, onSelect, onToggleGroup}
 * Keeps keyboard focus on the same logical item across re-renders.
 */
export function renderSessionList(container, view, ctx) {
  const active = document.activeElement;
  const focusKey = active && container.contains(active) ? active.dataset.key : null;
  clear(container);
  for (const g of view) {
    const sec = el('section', { cls: 'sess-group', data: { group: g.id }, attrs: { 'aria-label': g.title } });
    sec.appendChild(el('h3', { cls: 'group-title' }, [el('span', { text: g.title }), el('span', { cls: 'count', text: String(g.entries.length) })]));
    const ul = el('ul', { cls: 'plain' });
    for (const { s, agents } of g.entries) {
      const li = el('li', { cls: 'sess' }, [sessionButton(s, ctx)]);
      if (agents.length) li.appendChild(renderAgentGroups(s, agents, ctx));
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    container.appendChild(sec);
  }
  setRoving(container, focusKey);
  if (focusKey) {
    const target = [...container.querySelectorAll('[data-nav]')].find((n) => n.dataset.key === focusKey);
    if (target) target.focus({ preventScroll: true });
  }
}

/** Roving tabindex: the selected (or focused, or first) item is the single tab stop. */
function setRoving(container, preferKey) {
  const items = [...container.querySelectorAll('[data-nav]')];
  if (!items.length) return;
  const pick = items.find((n) => n.dataset.key === preferKey)
    || items.find((n) => n.getAttribute('aria-current') === 'true') || items[0];
  items.forEach((n) => n.setAttribute('tabindex', n === pick ? '0' : '-1'));
}

/** Arrow-key navigation over the [data-nav] items. Call once. */
export function installListKeys(container) {
  container.addEventListener('focusin', (e) => {
    if (e.target && e.target.dataset && e.target.dataset.nav) setRoving(container, e.target.dataset.key);
  });
  container.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = [...container.querySelectorAll('[data-nav]')];
    const i = items.indexOf(document.activeElement);
    if (i === -1) return;
    let n = null;
    if (e.key === 'ArrowDown') n = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') n = Math.max(0, i - 1);
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n === null) return;
    e.preventDefault();
    items[n].focus();
  });
}
