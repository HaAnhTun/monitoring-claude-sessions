// Timeline rendering. Rows are created once and updated in place, so scroll position,
// focus and <details> open state survive refreshes. All event text is untrusted and is
// only ever written with textContent (see markdown.js for the safe renderer).
import { el, icon, setIcon, clear } from './dom.js';
import { fmtClock, fmtDuration, timeTitle } from './format.js';
import { renderMarkdown } from './markdown.js';
import { collectToolNames, defaultFilters, unitVisible } from './filters.js';
import {
  atLatestEdge, followReducer, initialFollow, isErrorUnit, mergeEvents, pairEvents, stepError, toolDurationSec, unitSig,
} from './timeline-model.js';

const KIND_META = {
  prompt: { icon: 'user', label: 'Prompt' },
  say: { icon: 'bot', label: 'Claude' },
  think: { icon: 'layers', label: 'Thinking' },
  result: { icon: 'check', label: 'Result (tool not loaded)' },
};
const STATUS_META = {
  active: { icon: 'running', word: 'running' },
  completed: { icon: 'completed', word: 'ok' },
  failed: { icon: 'failed', word: 'failed' },
};
const CLAMP_CHARS = 1500;

function prettyInput(s) {
  if (typeof s !== 'string' || !s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

export function createTimeline(o) {
  const { scroller, list } = o;
  let sid = '';
  let agent = '';
  let events = [];
  let units = [];
  let unitByKey = new Map();
  let indexSet = new Set();
  const rows = new Map(); // key -> {el, sig, refs}
  const open = new Set(); // `${sid}|${agent}|${key}` of expanded tool calls
  let meta = { base: 0, total: 0, next: -1, partial: false, skipped: 0 };
  let gen = 0;
  let filters = defaultFilters();
  let newestFirst = true;
  let follow = initialFollow();
  let errCursor = null;
  let targetKey = null;
  let ticks = 0;

  const dispatch = (a) => {
    const n = followReducer(follow, a);
    if (n !== follow) { follow = n; o.onFollow(follow); }
  };

  scroller.addEventListener('scroll', () => {
    dispatch({ type: 'scroll', atEdge: atLatestEdge(scroller, newestFirst) });
  }, { passive: true });

  // ---- row construction ------------------------------------------------------

  function timeEl(iso) {
    const t = el('time', { cls: 'mono ev-time', text: fmtClock(iso) || '--:--:--' });
    if (iso) { t.setAttribute('datetime', iso); t.dataset.iso = iso; t.title = timeTitle(iso, Date.now()); }
    return t;
  }

  function copyBtn(what, getText) {
    return el('button', {
      cls: 'btn btn-icon', attrs: { type: 'button', 'aria-label': `Copy ${what}`, title: `Copy ${what}` },
      on: { click: (e) => { e.stopPropagation(); o.onCopy(getText(), what); } },
    }, [icon('copy')]);
  }

  function idxBtn(i) {
    return el('button', {
      cls: 'idx-btn mono', text: `#${i}`,
      attrs: { type: 'button', title: `Copy event index ${i}`, 'aria-label': `Copy event index ${i}` },
      on: { click: (e) => { e.stopPropagation(); o.onCopy(String(i), `event index ${i}`); } },
    });
  }

  function textBody(text, markdown) {
    const body = el('div', { cls: 'ev-body' });
    if (markdown) body.appendChild(renderMarkdown(text)); else body.textContent = text;
    const wrap = el('div', {}, [body]);
    if (text.length > CLAMP_CHARS) {
      body.classList.add('clamp');
      const more = el('button', {
        cls: 'btn btn-quiet', attrs: { type: 'button', 'aria-expanded': 'false' }, text: `Show more (${text.length.toLocaleString()} characters)`,
        on: { click: () => {
          const c = body.classList.toggle('clamp');
          more.setAttribute('aria-expanded', String(!c));
          more.textContent = c ? `Show more (${text.length.toLocaleString()} characters)` : 'Show less';
        } },
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function buildPlain(u) {
    const ev = u.ev;
    const m = KIND_META[u.kind] || { icon: 'help', label: u.kind };
    const text = typeof ev.text === 'string' ? ev.text : '';
    const li = el('li', { cls: `ev ev-${u.kind}${u.kind === 'result' && ev.err ? ' is-error' : ''}`, attrs: { id: `ev-${ev.i}`, tabindex: -1 }, data: { key: u.key, i: ev.i, kind: u.kind } });
    li.appendChild(el('div', { cls: 'ev-head' }, [
      el('span', { cls: 'ev-kind' }, [icon(m.icon), el('span', { text: m.label }), ...(u.kind === 'result' && ev.err ? [el('span', { cls: 'badge st-failed' }, [icon('failed'), el('span', { text: 'error' })])] : [])]),
      el('span', { cls: 'ev-meta' }, [
        idxBtn(ev.i),
        timeEl(ev.t),
        copyBtn('event text', () => text),
      ]),
    ]));
    li.appendChild(textBody(text, u.kind === 'prompt' || u.kind === 'say'));
    return { el: li, sig: unitSig(u), refs: {} };
  }

  function buildTool(u) {
    const ev = u.ev;
    const key = `${sid}|${agent}|${u.key}`;
    const li = el('li', { cls: 'ev ev-tool', attrs: { id: `ev-${ev.i}`, tabindex: -1 }, data: { key: u.key, i: ev.i, kind: 'tool' } });
    const details = el('details', { cls: 'tool' });
    if (open.has(key)) details.open = true;
    details.addEventListener('toggle', () => { if (details.open) open.add(key); else open.delete(key); });
    const statusIcon = icon('running');
    const statusText = el('span', { cls: 'tool-status-text' });
    const status = el('span', { cls: 'tool-status' }, [statusIcon, statusText]);
    const summary = el('summary', {}, [
      status,
      el('span', { cls: 'tool-name mono', text: ev.name || 'tool' }),
      el('span', { cls: 'tool-summary mono', text: ev.summary || '' }),
      el('span', { cls: 'ev-meta' }, [el('span', { cls: 'idx mono', text: `#${ev.i}` }), timeEl(ev.t)]),
    ]);
    const input = prettyInput(ev.input);
    const body = el('div', { cls: 'tool-body' }, [
      el('div', { cls: 'tool-actions' }, [
        copyBtn('tool input', () => ev.input || ''),
        copyBtn('tool id', () => String(ev.id ?? '')),
        idxBtn(ev.i),
      ]),
      el('div', { cls: 'field' }, [
        el('div', { cls: 'field-label', text: 'Input' }),
        el('pre', { cls: 'mono field-pre', text: input || '(empty)', attrs: { tabindex: 0 } }),
      ]),
    ]);
    details.appendChild(summary);
    details.appendChild(body);
    li.appendChild(details);
    const row = { el: li, sig: '', refs: { status, statusIcon, statusText, body } };
    updateTool(row, u);
    return row;
  }

  function updateTool(row, u) {
    const { refs, el: li } = row;
    const meta2 = STATUS_META[u.status];
    li.dataset.status = u.status;
    li.classList.toggle('is-error', u.status === 'failed');
    refs.status.className = `tool-status st-tool-${u.status}`;
    setIcon(refs.statusIcon, meta2.icon);
    if (u.status === 'active') li.dataset.since = u.ev.t || ''; else delete li.dataset.since;
    refs.status.dataset.word = meta2.word;
    refs.statusText.textContent = durationText(u);
    if (u.result && !refs.result) {
      const r = u.result;
      const text = typeof r.text === 'string' ? r.text : '';
      refs.result = el('div', { cls: `field tool-result${r.err ? ' is-error' : ''}` }, [
        el('div', { cls: 'field-label' }, [
          el('span', { text: r.err ? 'Result: error' : 'Result' }),
          el('span', { cls: 'idx mono', text: `#${r.i}` }),
          timeEl(r.t),
          copyBtn('tool result', () => text),
        ]),
        el('pre', { cls: 'mono field-pre', text: text || '(empty)', attrs: { tabindex: 0 } }),
      ]);
      refs.body.appendChild(refs.result);
    }
    row.sig = unitSig(u);
  }

  function durationText(u) {
    const sec = toolDurationSec(u, Date.now());
    const word = STATUS_META[u.status].word;
    return sec === null ? word : `${word} ${fmtDuration(sec)}`;
  }

  function buildRow(u) { return u.kind === 'tool' ? buildTool(u) : buildPlain(u); }

  // ---- ordering, filtering, scrolling -----------------------------------------

  function order() {
    const seq = newestFirst ? units.slice().reverse() : units;
    let ref = list.firstChild;
    for (const u of seq) {
      const node = rows.get(u.key).el;
      if (node === ref) ref = ref.nextSibling; else list.insertBefore(node, ref);
    }
    while (ref) { const n = ref.nextSibling; list.removeChild(ref); ref = n; }
  }

  function captureAnchor() {
    const top = scroller.getBoundingClientRect().top;
    for (const node of list.children) {
      if (node.hidden) continue;
      const r = node.getBoundingClientRect();
      if (r.bottom > top + 1) return { node, offset: r.top - top };
    }
    return null;
  }

  function restoreAnchor(a) {
    if (!a || !a.node.isConnected || a.node.hidden) return;
    const top = scroller.getBoundingClientRect().top;
    scroller.scrollTop += a.node.getBoundingClientRect().top - top - a.offset;
  }

  function snapToLatest() {
    scroller.scrollTop = newestFirst ? 0 : scroller.scrollHeight;
  }

  function applyFilters() {
    let visible = 0;
    let errors = 0;
    for (const u of units) {
      const row = rows.get(u.key);
      const show = unitVisible(u, filters);
      row.el.hidden = !show;
      row.el.classList.toggle('hide-result', !filters.kinds.result);
      if (show) { visible += 1; if (isErrorUnit(u)) errors += 1; }
    }
    return { visible, errors };
  }

  function stats(extra) {
    const first = events.length ? events[0].i : meta.base;
    return {
      loaded: events.length, units: units.length, base: meta.base, first, total: meta.total, next: meta.next,
      partial: meta.partial, skipped: meta.skipped, canLoadOlder: events.length > 0 && first > meta.base,
      ...extra,
    };
  }

  function sync({ keepView = false } = {}) {
    units = pairEvents(events);
    unitByKey = new Map(units.map((u) => [u.key, u]));
    indexSet = new Set(events.map((e) => e.i));
    const anchor = follow.follow || keepView ? null : captureAnchor();
    let structural = false;
    const live = new Set();
    for (const u of units) {
      live.add(u.key);
      const row = rows.get(u.key);
      if (!row) { rows.set(u.key, buildRow(u)); structural = true; }
      else if (row.sig !== unitSig(u) && u.kind === 'tool') updateTool(row, u);
    }
    for (const [k, row] of rows) {
      if (!live.has(k)) { rows.delete(k); row.el.remove(); structural = true; }
    }
    if (structural) order();
    const { visible, errors } = applyFilters();
    if (follow.follow) snapToLatest(); else restoreAnchor(anchor);
    o.onStats(stats({ visible, errors, toolNames: collectToolNames(units) }));
  }

  // ---- public API ---------------------------------------------------------------

  function clearRows() {
    rows.clear();
    clear(list);
    units = []; unitByKey = new Map(); indexSet = new Set();
  }

  const api = {
    get gen() { return gen; },
    get next() { return meta.next; },
    get follow() { return follow; },
    get sid() { return sid; },
    get agent() { return agent; },
    get newestFirst() { return newestFirst; },

    reset(newSid, newAgent) {
      gen += 1;
      sid = newSid; agent = newAgent || '';
      events = [];
      meta = { base: 0, total: 0, next: -1, partial: false, skipped: 0 };
      errCursor = null; targetKey = null;
      clearRows();
      follow = initialFollow();
      o.onFollow(follow);
      sync();
    },

    /** Poll response (after=next). Returns {needsReset} when the transcript shrank. */
    ingest(r) {
      if (events.length && meta.next >= 0 && r.total < meta.next) return { needsReset: true, added: 0 };
      const first = events.length === 0;
      const m = mergeEvents(events, r.events || []);
      events = m.events;
      meta = {
        base: r.base ?? r.from ?? 0, total: r.total ?? events.length, next: r.next ?? r.total ?? events.length,
        partial: !!r.partial, skipped: r.skipped_bytes || 0,
      };
      if (!first) dispatch({ type: 'events', count: m.added });
      sync();
      return { needsReset: false, added: m.added };
    },

    /** Response of before=N: older events, prepended. Does not touch the poll cursor. */
    ingestOlder(r) {
      const m = mergeEvents(events, r.events || []);
      events = m.events;
      if (typeof r.base === 'number') meta.base = Math.min(meta.base, r.base);
      sync();
      return m.added;
    },

    /** Replace everything with a window of events (jump to a far-away event). */
    replaceWindow(r) {
      gen += 1;
      events = [];
      clearRows();
      meta = { base: r.base ?? 0, total: r.total ?? 0, next: -1, partial: !!r.partial, skipped: r.skipped_bytes || 0 };
      const m = mergeEvents([], r.events || []);
      events = m.events;
      meta.next = r.next ?? r.total ?? (events.length ? events[events.length - 1].i + 1 : 0);
      dispatch({ type: 'off' });
      sync({ keepView: true });
    },

    setFilters(f) { filters = f; errCursor = null; sync(); },
    setNewestFirst(v) {
      if (v === newestFirst) return;
      const a = follow.follow ? null : captureAnchor();
      newestFirst = v;
      order();
      if (follow.follow) snapToLatest(); else restoreAnchor(a);
      const { visible, errors } = applyFilters();
      o.onStats(stats({ visible, errors, toolNames: collectToolNames(units) }));
    },

    toggleFollow() {
      dispatch({ type: 'toggle' });
      if (follow.follow) snapToLatest();
    },
    resumeFollow() { dispatch({ type: 'resume' }); snapToLatest(); },
    followOff() { dispatch({ type: 'off' }); },

    hasIndex: (i) => indexSet.has(i),
    first: () => (events.length ? events[0].i : meta.base),
    meta: () => ({ ...meta }),

    /** Scroll to an event index. Returns 'ok' | 'missing' | 'hidden'. */
    jumpTo(i) {
      let u = units.find((x) => x.ev.i === i || (x.result && x.result.i === i));
      if (!u) return 'missing';
      const row = rows.get(u.key);
      if (!row) return 'missing';
      if (row.el.hidden) return 'hidden';
      dispatch({ type: 'off' });
      if (targetKey && rows.get(targetKey)) rows.get(targetKey).el.classList.remove('is-target');
      targetKey = u.key;
      row.el.classList.add('is-target');
      const d = row.el.querySelector('details');
      if (d && (u.result && u.result.i === i || u.status === 'failed')) d.open = true;
      row.el.scrollIntoView({ block: 'center' });
      row.el.focus({ preventScroll: true });
      return 'ok';
    },

    /** Move to the next (dir=1, down the list) or previous (dir=-1) visible error. */
    stepError(dir) {
      const seq = newestFirst ? units.slice().reverse() : units;
      const keys = seq.filter((u) => isErrorUnit(u) && !rows.get(u.key).el.hidden).map((u) => u.key);
      const key = stepError(keys, errCursor, dir);
      if (key === null) return { ok: false, total: keys.length };
      errCursor = key;
      api.jumpTo(unitByKey.get(key).ev.i);
      return { ok: true, position: keys.indexOf(key) + 1, total: keys.length };
    },

    /** Called every second: live duration of running tool calls; every 30 s refresh time tooltips. */
    tick() {
      ticks += 1;
      for (const li of list.querySelectorAll('li[data-since]')) {
        const u = unitByKey.get(li.dataset.key);
        const status = li.querySelector('.tool-status-text');
        if (u && status) status.textContent = durationText(u);
      }
      if (ticks % 30 === 0) {
        const now = Date.now();
        for (const t of list.querySelectorAll('time[data-iso]')) t.title = timeTitle(t.dataset.iso, now);
      }
    },
  };
  return api;
}
