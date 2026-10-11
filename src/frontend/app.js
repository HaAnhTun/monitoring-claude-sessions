// Claude session monitor: page controller. Wires polling, health bar, session list,
// timeline, filters and panels together. No framework, no build step.
import { createApi } from './modules/api.js';
import { createPoller, nextDelay } from './modules/poller.js';
import { createPrefs, safeLocalStorage, parseHash, buildHash } from './modules/prefs.js';
import { computeHealth, countStates, titleFor, normalizeState } from './modules/health.js';
import { el, icon, setIcon, clear, button, announce, notify, initFeedback, copyText, stateBadge, tagBadge } from './modules/dom.js';
import { fmtAge, fmtMB, fmtClock, tokenLine, usageBadge, plural } from './modules/format.js';
import { KINDS, KIND_LABELS, defaultFilters, hasActiveFilters, searchQuery } from './modules/filters.js';
import { parseJump } from './modules/timeline-model.js';
import { createTimeline } from './modules/timeline.js';
import { buildSessionView, renderSessionList, installListKeys, stateMap, diffStates } from './modules/sessions.js';
import { renderMachine, renderOverview, renderLedger, renderChain, renderLogs, renderAttempts } from './modules/panels.js';

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

const prefs = createPrefs(safeLocalStorage());
const api = createApi();
initFeedback($('live-region'), $('toast'));

const S = {
  config: null,
  baseTitle: document.title && document.title !== '__TITLE__' ? document.title : 'Claude session monitor',
  poll: { events_ms: 1500, sessions_ms: 6000, machine_ms: 2000, logs_ms: 3000, overview_ms: 5000, attempts_ms: 6000, stale_after_ms: 20000 },
  panels: {},
  sessions: null,
  prevStates: null,
  sel: { sid: '', agent: '' },
  showAll: prefs.get('showAll', false),
  filterText: prefs.get('filter', ''),
  groupState: new Map(),
  filters: defaultFilters(),
  newestFirst: true,
  health: null,
  task: null,
  taskInfo: null,
  eventsState: 'idle', // idle | loading | ready
  tstats: null,
  conn: 'connecting',
  stale: false,
  serverErrT: null,
  searchSeq: 0,
};
const pollers = {};

// ---------------------------------------------------------------- preferences

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme-label').textContent = `Theme: ${t}`;
  setIcon($('theme-toggle').querySelector('svg'), t === 'dark' ? 'moon' : 'sun');
}
function applyDensity(d) {
  document.documentElement.dataset.density = d;
  $('density-label').textContent = `Density: ${d}`;
}
$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[cur] || 'auto';
  applyTheme(next);
  prefs.set('theme', next);
  announce(`Theme ${next}`);
});
$('density-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.density === 'compact' ? 'comfortable' : 'compact';
  applyDensity(next);
  prefs.set('density', next);
  announce(`Density ${next}`);
});
applyTheme(prefs.get('theme', 'auto'));
applyDensity(prefs.get('density', 'comfortable'));

// ---------------------------------------------------------------- timeline

const timeline = createTimeline({
  scroller: $('timeline'),
  list: $('timeline-list'),
  onFollow: renderFollow,
  onStats: onTimelineStats,
  onCopy: async (text, what) => {
    const ok = await copyText(text);
    notify(ok ? `Copied ${what}` : `Could not copy ${what}`);
  },
});

function renderFollow(f) {
  $('follow-toggle').checked = f.follow;
  const btn = $('resume-follow');
  btn.hidden = f.follow || !S.sel.sid;
  btn.textContent = f.unseen ? `Resume following (${f.unseen} new)` : 'Resume following';
  $('timeline').closest('.timeline-frame').dataset.edge = S.newestFirst ? 'top' : 'bottom';
}

function placeOlderRow() {
  const sc = $('timeline');
  const row = $('timeline-load-older');
  if (S.newestFirst) sc.insertBefore(row, $('timeline-empty')); else sc.insertBefore(row, $('timeline-list'));
}

function onTimelineStats(st) {
  S.tstats = st;
  // tool dropdown: rebuild only when the set of names changes
  if (st.toolNames) {
    const sel = $('tool-filter');
    const have = [...sel.options].slice(1).map((o) => o.value).join('\n');
    if (have !== st.toolNames.join('\n')) {
      const keep = S.filters.tool;
      while (sel.options.length > 1) sel.remove(1);
      for (const n of st.toolNames) sel.add(new Option(n, n));
      if (keep && !st.toolNames.includes(keep)) sel.add(new Option(keep, keep));
      sel.value = keep;
    }
  }
  const parts = [];
  if (st.units !== undefined && S.sel.sid) {
    parts.push(`Showing ${st.visible} of ${st.units} loaded items`);
    parts.push(plural(st.errors, 'error'));
    if (st.loaded) parts.push(`events #${st.first} to #${st.first + st.loaded - 1} of ${st.total}`);
  }
  $('timeline-count').textContent = parts.join(' · ');
  // partial history banner and load-older controls
  const banner = $('partial-banner');
  banner.hidden = !st.partial;
  if (st.partial) {
    $('partial-text').textContent = st.skipped
      ? `Showing only the latest events (${fmtMB(st.skipped)} of older history not loaded)`
      : 'Showing only the latest events (older history not loaded)';
  }
  const lo = $('load-older');
  lo.disabled = !st.canLoadOlder;
  lo.title = st.canLoadOlder ? 'Load the 250 events before the oldest loaded one' : 'No older events are available from the monitor';
  $('timeline-load-older').hidden = !st.canLoadOlder;
  if (st.canLoadOlder) $('older-note').textContent = `${st.first - st.base} earlier events available`;
  renderTimelineEmpty();
  renderFollow(timeline.follow);
}

function renderTimelineEmpty() {
  const box = $('timeline-empty');
  const st = S.tstats;
  let msg = '';
  if (!S.sel.sid) msg = 'Select a session to see its events.';
  else if (S.eventsState === 'loading') msg = 'Loading events...';
  else if (st && st.units === 0) msg = 'No events recorded for this session yet.';
  else if (st && st.visible === 0) msg = 'No events match the current filters.';
  box.textContent = msg;
  box.hidden = !msg;
}

function renderTimelineStatus() {
  const box = $('timeline-status');
  const st = S.sel.sid ? api.status('events') : null;
  if (!st || !st.failures || !st.lastError) { box.hidden = true; return; }
  const msg = st.lastError.status === 404
    ? 'The monitor does not know this session (it may be outside the time window or was removed).'
    : `Could not refresh events: ${st.lastError.message}. Showing the events loaded earlier.`;
  box.textContent = msg;
  box.hidden = false;
}

// ---------------------------------------------------------------- filters UI

function currentKinds() { return { ...S.filters.kinds }; }

function buildKindFilter() {
  const fs = $('kind-filter');
  for (const k of KINDS) {
    const cb = el('input', { attrs: { type: 'checkbox' }, data: { kind: k } });
    cb.id = `kind-${k}`;
    cb.addEventListener('change', () => {
      S.filters = { ...S.filters, kinds: { ...S.filters.kinds, [k]: cb.checked } };
      prefs.set('kinds', currentKinds());
      timeline.setFilters(S.filters);
    });
    fs.appendChild(el('label', { cls: 'check' }, [cb, el('span', { text: KIND_LABELS[k] })]));
  }
}
function syncKindBoxes() {
  for (const k of KINDS) $(`kind-${k}`).checked = !!S.filters.kinds[k];
}

let searchTimer = null;
$('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => { S.filters = { ...S.filters, q: v }; timeline.setFilters(S.filters); }, 150);
});
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.value) {
    e.target.value = '';
    S.filters = { ...S.filters, q: '' };
    timeline.setFilters(S.filters);
  }
});
$('tool-filter').addEventListener('change', (e) => { S.filters = { ...S.filters, tool: e.target.value }; timeline.setFilters(S.filters); });
$('errors-only').addEventListener('change', (e) => { S.filters = { ...S.filters, errorsOnly: e.target.checked }; timeline.setFilters(S.filters); });
$('newest-first').addEventListener('change', (e) => {
  S.newestFirst = e.target.checked;
  prefs.set('newestFirst', S.newestFirst);
  timeline.setNewestFirst(S.newestFirst);
  placeOlderRow();
  renderFollow(timeline.follow);
});
$('follow-toggle').addEventListener('change', (e) => { if (e.target.checked) timeline.resumeFollow(); else timeline.followOff(); });
$('resume-follow').addEventListener('click', () => { timeline.resumeFollow(); announce('Following new events'); });

function clearFilters() {
  S.filters = { ...S.filters, q: '', tool: '', errorsOnly: false };
  $('search-input').value = '';
  $('tool-filter').value = '';
  $('errors-only').checked = false;
  timeline.setFilters(S.filters);
}

function stepError(dir) {
  const r = timeline.stepError(dir);
  if (r.ok) announce(`Error ${r.position} of ${r.total}`);
  else notify(r.total ? 'No more errors in that direction' : 'No errors in the loaded events');
}
$('next-error').addEventListener('click', () => stepError(1));
$('prev-error').addEventListener('click', () => stepError(-1));

// ---------------------------------------------------------------- events polling

async function pollEvents() {
  if (!S.sel.sid) return;
  let gen = timeline.gen;
  const { sid, agent } = S.sel;
  for (let loops = 0; loops < 3; loops += 1) {
    const url = `/api/events?sid=${enc(sid)}&agent=${enc(agent)}&after=${timeline.next}`;
    const r = await api.get('events', url);
    if (gen !== timeline.gen) return; // the selection changed while waiting
    const res = timeline.ingest(r);
    S.eventsState = 'ready';
    renderTimelineStatus();
    if (res.needsReset) {
      timeline.reset(sid, agent);
      gen = timeline.gen;
      notify('The transcript was reset; reloading events');
      continue;
    }
    if (r.next >= r.total) break;
  }
  renderTimelineEmpty();
}

async function loadOlder() {
  const meta = timeline.meta();
  const first = timeline.first();
  if (first <= meta.base) return;
  const gen = timeline.gen;
  const { sid, agent } = S.sel;
  for (const b of [$('load-older'), $('load-older-edge')]) { b.disabled = true; b.classList.add('is-loading'); }
  try {
    const r = await api.get('events-older', `/api/events?sid=${enc(sid)}&agent=${enc(agent)}&before=${first}&limit=250`);
    if (gen !== timeline.gen) return;
    const n = timeline.ingestOlder(r);
    announce(`Loaded ${n} older events`);
  } catch (e) {
    notify(`Could not load older events: ${e.message}`);
  } finally {
    for (const b of [$('load-older'), $('load-older-edge')]) { b.classList.remove('is-loading'); }
    onTimelineStats({ ...S.tstats, canLoadOlder: timeline.first() > timeline.meta().base, first: timeline.first(), base: timeline.meta().base });
  }
}
$('load-older').addEventListener('click', loadOlder);
$('load-older-edge').addEventListener('click', loadOlder);

// ---------------------------------------------------------------- jump and whole-transcript search

async function revealIndex(i, base) {
  const gen = timeline.gen;
  const { sid, agent } = S.sel;
  if (!timeline.hasIndex(i)) {
    const after = Math.max(base ?? timeline.meta().base, i - 15);
    let r;
    try {
      r = await api.get('events-window', `/api/events?sid=${enc(sid)}&agent=${enc(agent)}&after=${after}`);
    } catch (e) { notify(`Could not load events around #${i}: ${e.message}`); return; }
    if (gen !== timeline.gen) return;
    timeline.replaceWindow(r);
    S.eventsState = 'ready';
  }
  let res = timeline.jumpTo(i);
  if (res === 'hidden') {
    clearFilters();
    res = timeline.jumpTo(i);
    if (res === 'ok') notify(`Filters cleared to show event #${i}`);
  }
  if (res === 'ok') announce(`Jumped to event #${i}`);
  else notify(`Event #${i} is not available`);
}

async function locateAndReveal(spec) {
  if (!S.sel.sid) { notify('Select a session first'); return; }
  const qs = new URLSearchParams({ sid: S.sel.sid, agent: S.sel.agent });
  if (spec.type === 'index') qs.set('i', String(spec.i)); else qs.set('ts', spec.ts);
  try {
    const loc = await api.get('locate', `/api/locate?${qs}`);
    await revealIndex(loc.i, loc.base);
  } catch (e) { notify(`Jump failed: ${e.message}`); }
}

$('jump-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const spec = parseJump($('jump-input').value);
  if (!spec) { notify('Enter an event number such as 120, or a time such as 12:30'); return; }
  locateAndReveal(spec);
});

function closeSearchResults() { $('search-results').hidden = true; clear($('search-results-list')); }
$('search-results-close').addEventListener('click', () => { closeSearchResults(); $('search-whole').focus(); });

async function searchWhole() {
  if (!S.sel.sid) { notify('Select a session first'); return; }
  if (!(S.filters.q || '').trim() && !hasActiveFilters(S.filters)) { notify('Type a search text (or choose a tool / errors only) first'); $('search-input').focus(); return; }
  const seq = ++S.searchSeq;
  const gen = timeline.gen;
  const btn = $('search-whole');
  btn.disabled = true; btn.classList.add('is-loading');
  try {
    const r = await api.get('search', `/api/search?${searchQuery(S.filters, S.sel.sid, S.sel.agent)}`);
    if (seq !== S.searchSeq || gen !== timeline.gen) return;
    renderSearchResults(r);
  } catch (e) {
    notify(`Search failed: ${e.message}`);
  } finally { btn.disabled = false; btn.classList.remove('is-loading'); }
}
$('search-whole').addEventListener('click', searchWhole);

function renderSearchResults(r) {
  const box = $('search-results');
  box.hidden = false;
  $('search-results-title').textContent = `Search results: ${plural(r.count ?? r.matches.length, 'match', 'matches')}`;
  const notes = [];
  if (r.truncated) notes.push(`only the first ${r.matches.length} are listed`);
  if (r.partial) notes.push('older events were not loaded by the monitor, so results may be incomplete');
  $('search-results-note').textContent = notes.length ? `Note: ${notes.join('; ')}.` : (r.matches.length ? 'Select a result to jump to it.' : 'No matches.');
  const ul = $('search-results-list');
  clear(ul);
  for (const m of r.matches) {
    const label = { prompt: 'Prompt', say: 'Claude', think: 'Thinking', tool: 'Tool', result: 'Result' }[m.k] || m.k;
    ul.appendChild(el('li', {}, [el('button', {
      cls: 'sr-item', attrs: { type: 'button' }, on: { click: () => revealIndex(m.i) },
    }, [
      el('span', { cls: 'mono', text: `#${m.i}` }),
      el('span', { cls: 'mono', text: fmtClock(m.t) }),
      el('strong', { text: m.name ? `${label} ${m.name}` : label }),
      el('span', { cls: 'sr-snippet', text: m.snippet || '' }),
    ])]));
  }
  box.querySelector('h2').scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- sessions

function writeHash() {
  try { history.replaceState(null, '', location.pathname + location.search + buildHash(S.sel)); } catch { /* sandboxed */ }
}

function select(sid, agent = '', { syncHash = true } = {}) {
  if (S.sel.sid === sid && S.sel.agent === agent && timeline.sid === sid && timeline.agent === agent) return;
  S.sel = { sid, agent };
  prefs.set('sel', { sid, agent });
  if (syncHash) writeHash();
  timeline.reset(sid, agent);
  S.eventsState = sid ? 'loading' : 'idle';
  S.searchSeq += 1;
  closeSearchResults();
  renderSessions();
  renderInfo();
  renderTimelineEmpty();
  renderTimelineStatus();
  if (pollers.events) pollers.events.trigger();
}

const sessionCtx = {
  get selected() { return S.sel; },
  groupState: S.groupState,
  onSelect: (sid, agent) => select(sid, agent),
  onToggleGroup: (key, val) => { S.groupState.set(key, val); renderSessions(); },
};

function renderEmptyState() {
  const box = $('empty-state');
  clear(box);
  const c = S.config || {};
  box.appendChild(el('h3', { text: 'No sessions to show' }));
  box.appendChild(el('p', { cls: 'small', text: 'The monitor is running but returned no sessions. Likely causes:' }));
  const ul = el('ul');
  const item = (flag, text) => ul.appendChild(el('li', {}, flag ? [el('span', { cls: 'flag', text: 'Likely here: ' }), document.createTextNode(text)] : [document.createTextNode(text)]));
  item(c.transcripts_dir === false, 'The Claude Code transcripts folder for this repository was not found (set transcripts_dir in the config).');
  item(c.transcripts_dir !== false && !S.showAll, 'No session rule matched any session. Tick "Show unmatched sessions" to list everything, or fix the rules (session_rules).');
  item(false, `Only sessions written to in the last ${c.window_hours ?? 'N'} hours are listed (window_hours); older ones are hidden.`);
  box.appendChild(ul);
  box.hidden = false;
}

function renderSessions() {
  const box = $('session-list');
  const empty = $('empty-state');
  if (S.sessions === null) {
    const st = api.status('sessions');
    clear(box);
    box.setAttribute('aria-busy', st && st.failures ? 'false' : 'true');
    if (st && st.failures && st.lastError) {
      box.appendChild(el('p', { cls: 'banner banner-error' }, [icon('alert'), el('span', { text: `Could not load sessions: ${st.lastError.message}. Retrying automatically.` })]));
    } else {
      box.appendChild(el('p', { cls: 'muted loading' }, [el('span', { cls: 'spinner' }), document.createTextNode(' Loading sessions...')]));
    }
    empty.hidden = true;
    return;
  }
  box.setAttribute('aria-busy', 'false');
  if (!S.sessions.length) { clear(box); renderEmptyState(); return; }
  empty.hidden = true;
  const view = buildSessionView(S.sessions, S.filterText);
  if (!view.length) {
    clear(box);
    box.appendChild(el('p', { cls: 'muted' }, [document.createTextNode(`No session matches "${S.filterText}". `),
      el('button', { cls: 'link-btn', attrs: { type: 'button' }, text: 'Clear filter', on: { click: () => { $('session-filter').value = ''; setFilterText(''); } } })]));
    return;
  }
  renderSessionList(box, view, sessionCtx);
}

function setFilterText(v) {
  S.filterText = v;
  prefs.set('filter', v);
  renderSessions();
}
$('session-filter').addEventListener('input', (e) => setFilterText(e.target.value));
$('show-all').addEventListener('change', (e) => {
  S.showAll = e.target.checked;
  prefs.set('showAll', S.showAll);
  $('session-list').setAttribute('aria-busy', 'true');
  if (pollers.sessions) pollers.sessions.trigger();
});

function findSelected() {
  const s = (S.sessions || []).find((x) => x.id === S.sel.sid);
  if (!s) return { s: null, a: null };
  const a = S.sel.agent ? (s.agents || []).find((x) => x.agent === S.sel.agent) || null : null;
  return { s, a };
}

function renderInfo() {
  const box = $('session-info');
  clear(box);
  if (!S.sel.sid) { box.appendChild(el('p', { cls: 'muted', text: 'Select a session on the left.' })); return; }
  const { s, a } = findSelected();
  const item = a || s;
  const title = s ? (a ? `${s.label} / ${a.label}` : s.label) : S.sel.sid;
  box.appendChild(el('span', { cls: 'info-title', text: title }));
  if (item) {
    box.appendChild(stateBadge(normalizeState(item.state), item.state_evidence));
    if (item.state_evidence) box.appendChild(el('span', { cls: 'muted', text: item.state_evidence }));
    const usage = a ? a.usage : (s.usage_total || s.usage);
    box.appendChild(el('span', { cls: 'mono', text: tokenLine(usage) + (!a && (s.agents || []).length ? ' (incl. subagents)' : '') }));
    const ub = usageBadge(usage, item.completeness);
    if (ub) box.appendChild(tagBadge(ub.kind, ub.text, 'alert', ub.tip));
    const u = a ? a.usage : s.usage;
    if (u && u.models && u.models.length) box.appendChild(el('span', { cls: 'mono muted', text: u.models.join(', ') }));
    if (u && u.turns) box.appendChild(el('span', { cls: 'mono muted', text: plural(u.turns, 'turn') }));
  } else if (S.sessions) {
    box.appendChild(tagBadge('partial', 'not in list', 'alert', 'This session is not in the current list (outside the time window or not matched). Events are still loaded.'));
  }
  box.appendChild(button({
    icon: 'link', text: 'Copy link', title: 'Copy a link that reopens this session',
    on: { click: async () => { const ok = await copyText(location.href.split('#')[0] + buildHash(S.sel)); notify(ok ? 'Copied link' : 'Could not copy link'); } },
    cls: 'btn-quiet',
  }));
}

function onSessions(list) {
  const first = S.sessions === null;
  S.sessions = list;
  const map = stateMap(list);
  if (S.prevStates) {
    const ch = diffStates(S.prevStates, map);
    ch.slice(0, 3).forEach((c) => announce(`${c.label}: ${c.from} to ${c.to}`));
    if (ch.length > 3) announce(`${ch.length} sessions changed state`);
  }
  S.prevStates = map;
  if (!S.sel.sid && list.length) {
    const pick = list.find((s) => normalizeState(s.state) === 'RUNNING') || list[0];
    select(pick.id, '');
  }
  renderSessions();
  renderInfo();
  updateTitle();
  if (first) $('session-list').setAttribute('aria-busy', 'false');
}

// ---------------------------------------------------------------- panels

const PANEL_ENDPOINTS = { 'panel-overview': 'overview', 'panel-machine': 'machine', 'panel-attempts': 'attempts', 'panel-ledger': 'overview', 'panel-chain': 'overview', 'panel-logs': 'logs' };

function panelOn(key) { return !!S.panels[key]; }

function renderPanelStatus() {
  const now = Date.now();
  for (const [id, ep] of Object.entries(PANEL_ENDPOINTS)) {
    const sec = $(id);
    if (sec.hidden) continue;
    const st = api.status(ep);
    const note = sec.querySelector('.panel-status');
    let msg = '';
    if (st && st.failures && st.lastError) {
      msg = st.lastSuccess ? `Could not refresh: ${st.lastError.message}. Showing data from ${fmtAge((now - st.lastSuccess) / 1000)} ago.` : `Could not load: ${st.lastError.message}.`;
    } else if (st && st.lastSuccess && now - st.lastSuccess > S.poll.stale_after_ms) {
      msg = `Stale: no update for ${fmtAge((now - st.lastSuccess) / 1000)}.`;
    }
    note.textContent = msg;
    note.hidden = !msg;
    sec.classList.toggle('is-stale', !!msg);
  }
}

function setupPanels() {
  const map = { 'panel-overview': 'git', 'panel-machine': 'machine', 'panel-attempts': 'attempts', 'panel-ledger': 'ledger', 'panel-chain': 'chain_log', 'panel-logs': 'logs' };
  const collapsed = prefs.get('collapsed', {});
  const narrow = window.matchMedia('(max-width: 899px)').matches;
  for (const [id, key] of Object.entries(map)) {
    const sec = $(id);
    sec.hidden = !panelOn(key);
    const toggle = sec.querySelector('.panel-toggle');
    const body = sec.querySelector('.panel-body');
    const setOpen = (open) => {
      toggle.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    };
    setOpen(!(key in collapsed ? collapsed[key] : narrow));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
      prefs.set('collapsed', { ...prefs.get('collapsed', {}), [key]: !open });
    });
  }
}

// ---------------------------------------------------------------- health bar

function retryInSeconds(failing) {
  const now = Date.now();
  const times = failing.map((n) => (pollers[n] ? pollers[n].state.nextAt : 0)).filter((t) => t > now);
  return times.length ? Math.max(0, Math.ceil((Math.min(...times) - now) / 1000)) : null;
}

function renderHealth() {
  const now = Date.now();
  const core = S.config ? ['health', 'sessions'] : ['config'];
  if (S.sel.sid) core.push('events');
  const h = computeHealth({ records: api.snapshot(), now, staleAfterMs: S.poll.stale_after_ms, coreNames: core });

  const chip = $('health-status');
  chip.dataset.status = h.connection;
  const retry = retryInSeconds(h.failing);
  const text = {
    connecting: 'Connecting...',
    ok: 'Monitor connected',
    reconnecting: `Reconnecting${retry !== null ? ` (retry in ${retry}s)` : ''}`,
    lost: `Connection lost${retry !== null ? ` (retry in ${retry}s)` : ''}`,
  }[h.connection];
  chip.querySelector('.chip-text').textContent = text;
  setIcon(chip.querySelector('svg'), { connecting: 'clock', ok: 'check', reconnecting: 'refresh', lost: 'wifi-off' }[h.connection]);

  $('health-age').textContent = h.ageMs === null ? 'not updated yet' : `updated ${fmtAge(h.ageMs / 1000)} ago`;
  const stale = $('stale-badge');
  stale.hidden = !h.stale;
  if (h.stale) stale.querySelector('.chip-text').textContent = `STALE: no update for ${fmtAge(h.ageMs / 1000)}`;
  const err = $('health-error');
  err.hidden = !h.lastError;
  if (h.lastError) err.textContent = `${h.lastError.name}: ${h.lastError.message}`;

  const failing = h.connection === 'lost' || h.connection === 'reconnecting';
  $('retry-label').textContent = failing ? 'Retry now' : 'Refresh';
  $('retry-btn').classList.toggle('is-loading', Object.values(pollers).some((p) => p.running));
  document.body.dataset.stale = String(h.stale || h.connection === 'lost');

  const msgs = [];
  if (h.connection !== S.conn) {
    if (h.connection === 'lost') msgs.push('Connection to the monitor lost. Showing the last data received.');
    else if (h.connection === 'ok' && (S.conn === 'lost' || S.conn === 'reconnecting')) msgs.push('Connection to the monitor restored.');
    else if (h.connection === 'reconnecting') msgs.push('Monitor not responding. Retrying.');
    S.conn = h.connection;
  }
  if (h.stale !== S.stale) {
    msgs.push(h.stale ? 'Data is stale: no recent update.' : 'Data is up to date again.');
    S.stale = h.stale;
  }
  if (msgs.length) announce(msgs.join(' '));
  updateTitle(h.connection);
  renderPanelStatus();
  if ($('health-details').hidden === false) renderHealthDetails();
  if (S.sessions === null) renderSessions();
  renderTimelineStatus();
}

function updateTitle(conn = S.conn) {
  const counts = countStates(S.sessions || []);
  document.title = titleFor(counts, S.baseTitle, conn);
}

function renderHealthDetails() {
  const now = Date.now();
  const ul = $('endpoint-list');
  clear(ul);
  for (const r of api.snapshot()) {
    const ok = r.lastSuccess ? `ok ${fmtAge((now - r.lastSuccess) / 1000)} ago` : 'never ok';
    const bad = r.failures ? `; ${plural(r.failures, 'failure')} in a row, last: ${r.lastError ? r.lastError.message : ''}` : '';
    ul.appendChild(el('li', { text: `${r.name}: ${ok}${bad}` }));
  }
  const h = S.health;
  $('monitor-info').textContent = h
    ? `Monitor v${h.version ?? '?'} · pid ${h.pid ?? '?'} · up ${fmtAge(h.uptime)} · config: ${h.config_source ?? '?'} · transcripts folder: ${h.transcripts_dir ? 'found' : 'NOT found'}${h.reader ? ` · ${h.reader.files} transcript files, ${h.reader.invalid_lines} invalid lines` : ''}`
    : 'No health data yet.';
  const list = (h && h.errors) || [];
  const serverErrors = $('server-errors');
  clear(serverErrors);
  if (!list.length) serverErrors.appendChild(el('li', { cls: 'muted', text: 'No server-side errors recorded.' }));
  for (const e of list.slice().reverse()) serverErrors.appendChild(el('li', { text: `${fmtClock(new Date(e.t * 1000).toISOString())} ${e.where}: ${e.message}` }));
  const lc = S.taskInfo && S.taskInfo.last_change;
  $('last-change').textContent = lc ? `Last config change: ${lc.summary} (${lc.t})` : '';
}

$('health-details-btn').addEventListener('click', () => {
  const box = $('health-details');
  const open = box.hidden;
  box.hidden = !open;
  $('health-details-btn').setAttribute('aria-expanded', String(open));
  if (open) renderHealthDetails();
});

function triggerAll() {
  for (const p of Object.values(pollers)) p.trigger();
  if (wakeConfig) wakeConfig();
  renderHealth();
}
$('retry-btn').addEventListener('click', () => { triggerAll(); announce('Refreshing'); });

function setTask(task) {
  S.task = task;
  const name = task && (task.name || task.id);
  $('task-name').textContent = name ? `Task: ${name}` : '';
}

// ---------------------------------------------------------------- polling setup

async function pollHealth() {
  const h = await api.get('health', '/api/health');
  S.health = h;
  if (h.task && (!S.task || S.task.id !== h.task.id || S.task.name !== h.task.name)) setTask(h.task);
  const errs = h.errors || [];
  const newest = errs.length ? Math.max(...errs.map((e) => e.t)) : 0;
  if (S.serverErrT !== null && newest > S.serverErrT) {
    const e = errs.find((x) => x.t === newest);
    announce(`The monitor reported a new error in ${e.where}: ${e.message}`);
  }
  S.serverErrT = Math.max(S.serverErrT ?? 0, newest);
  renderHealth();
}

function startPollers() {
  const P = S.poll;
  const add = (name, run, ms) => {
    pollers[name] = createPoller({ name, run, getInterval: () => ms(), onError: () => renderHealth() });
    return pollers[name];
  };
  add('health', pollHealth, () => Math.max(5000, P.overview_ms));
  add('sessions', async () => { onSessions(await api.get('sessions', `/api/sessions?all=${S.showAll ? 1 : 0}`)); }, () => P.sessions_ms);
  add('events', pollEvents, () => P.events_ms);
  add('task', async () => {
    const t = await api.get('task', '/api/task');
    S.taskInfo = t;
    if (t.task) setTask(t.task);
  }, () => 15000);
  if (panelOn('machine')) add('machine', async () => { renderMachine($('body-machine'), await api.get('machine', '/api/machine')); }, () => P.machine_ms);
  if (panelOn('attempts')) add('attempts', async () => { renderAttempts($('body-attempts'), await api.get('attempts', '/api/attempts'), (sid) => select(sid, '')); }, () => P.attempts_ms);
  if (panelOn('logs')) add('logs', async () => { renderLogs($('body-logs'), await api.get('logs', '/api/logs')); }, () => P.logs_ms);
  if (panelOn('git') || panelOn('ledger') || panelOn('chain_log')) {
    add('overview', async () => {
      const o = await api.get('overview', '/api/overview');
      if (panelOn('git')) renderOverview($('body-overview'), o);
      if (panelOn('ledger')) renderLedger($('body-ledger'), o);
      if (panelOn('chain_log')) renderChain($('body-chain'), o);
    }, () => P.overview_ms);
  }
  Object.values(pollers).forEach((p) => p.start());
}

let wakeConfig = null;
const sleepWakeable = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  wakeConfig = () => { clearTimeout(t); resolve(); };
});

async function loadConfig() {
  let failures = 0;
  for (;;) {
    try {
      S.config = await api.get('config', '/api/config');
      wakeConfig = null;
      return;
    } catch {
      failures += 1;
      renderHealth();
      await sleepWakeable(nextDelay(2000, failures));
    }
  }
}

function applyConfig() {
  const c = S.config;
  const ui = c.ui || {};
  S.poll = { ...S.poll, ...(c.poll || {}) };
  S.panels = c.panels || {};
  S.baseTitle = c.title || S.baseTitle;
  $('app-title').textContent = S.baseTitle;
  if (c.task) setTask(c.task);
  applyTheme(prefs.get('theme', ui.theme || 'auto'));
  applyDensity(prefs.get('density', ui.density || 'comfortable'));
  S.newestFirst = prefs.get('newestFirst', ui.newest_first !== false);
  $('newest-first').checked = S.newestFirst;
  timeline.setNewestFirst(S.newestFirst);
  placeOlderRow();
  const base = defaultFilters(ui);
  S.filters = { ...base, kinds: { ...base.kinds, ...prefs.get('kinds', {}) } };
  syncKindBoxes();
  timeline.setFilters(S.filters);
  $('sessions-window').textContent = c.window_hours ? `Sessions touched in the last ${c.window_hours} h` : '';
  setupPanels();
  renderSessions();
}

// ---------------------------------------------------------------- shortcuts and navigation

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password', 'date', 'time', '']);
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  if (tag === 'INPUT' && TEXT_INPUT_TYPES.has(t.type || '')) return;
  if ($('shortcuts-dialog').open) return;
  if (e.key === '/') { e.preventDefault(); $('search-input').focus(); $('search-input').select(); }
  else if (e.key === 'f') { e.preventDefault(); if (timeline.follow.follow) timeline.followOff(); else timeline.resumeFollow(); announce(timeline.follow.follow ? 'Following new events' : 'Follow off'); }
  else if (e.key === ']') { e.preventDefault(); stepError(1); }
  else if (e.key === '[') { e.preventDefault(); stepError(-1); }
  else if (e.key === '?') { e.preventDefault(); $('shortcuts-dialog').showModal(); }
});
$('shortcuts-btn').addEventListener('click', () => $('shortcuts-dialog').showModal());

for (const a of document.querySelectorAll('.skip-link')) {
  a.addEventListener('click', (e) => {
    e.preventDefault(); // keep the #sid=... hash intact
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    const focusable = target.matches('[tabindex]') ? target : (target.querySelector('[data-nav][tabindex="0"], button, [tabindex]') || target);
    focusable.focus();
  });
}

window.addEventListener('hashchange', () => {
  const h = parseHash(location.hash);
  if (h.sid && (h.sid !== S.sel.sid || h.agent !== S.sel.agent)) select(h.sid, h.agent, { syncHash: false });
});

// ---------------------------------------------------------------- boot

async function boot() {
  installListKeys($('session-list'));
  buildKindFilter();
  syncKindBoxes();
  $('session-filter').value = S.filterText;
  $('show-all').checked = S.showAll;
  $('newest-first').checked = true;
  placeOlderRow();

  // selection: URL hash wins over the saved one
  const fromHash = parseHash(location.hash);
  const saved = prefs.get('sel', { sid: '', agent: '' });
  const start = fromHash.sid ? fromHash : saved;
  if (start.sid) select(start.sid, start.agent || '', { syncHash: !!fromHash.sid });

  setInterval(() => { renderHealth(); timeline.tick(); }, 1000);
  api.onChange(() => requestAnimationFrame(() => { renderPanelStatus(); }));
  renderHealth();
  window.__ccm = { api, state: S, timeline, pollers };

  await loadConfig();
  applyConfig();
  startPollers();
  renderHealth();
  setTimeout(() => document.body.classList.remove('booting'), 700);
}

boot();
