// Side panels: machine, overview, attempts, ledger, chain log, live logs. DOM via textContent only.
import { el, icon, clear, stateBadge, tagBadge } from './dom.js';
import { fmtAge, fmtDuration, fmtTok, fmtBytes } from './format.js';
import { normalizeState } from './health.js';

/** Meter with a text value (never colour alone). */
function meter(label, pct, valueText) {
  const p = pct === null || pct === undefined || Number.isNaN(Number(pct)) ? null : Math.max(0, Math.min(100, Number(pct)));
  const high = p !== null && p > 90;
  const fill = el('span', { cls: 'meter-fill' });
  fill.style.width = `${p ?? 0}%`;
  const bar = el('div', {
    cls: `meter${high ? ' is-high' : ''}`,
    attrs: { role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': p === null ? undefined : p, 'aria-valuetext': valueText },
  }, [fill]);
  const head = el('div', { cls: 'meter-head' }, [el('span', { text: label }), el('span', { cls: 'mono', text: valueText })]);
  if (high) head.appendChild(tagBadge('failed', 'high', 'alert'));
  return el('div', { cls: 'meter-row' }, [head, bar]);
}

export function renderMachine(box, m) {
  clear(box);
  const used = m.total_gb !== undefined && m.free_gb !== undefined ? +(m.total_gb - m.free_gb).toFixed(1) : null;
  box.appendChild(meter('RAM', m.used_pct, `${used ?? '?'} GB used of ${m.total_gb ?? '?'} GB (${m.used_pct ?? '?'}%)`));
  box.appendChild(meter('CPU', m.cpu_pct, m.cpu_pct === null || m.cpu_pct === undefined ? 'measuring...' : `${m.cpu_pct}%`));
  const procs = m.procs || [];
  if (procs.length) {
    const t = el('table', { cls: 'tbl' }, [el('caption', { cls: 'sr-only', text: 'Watched processes' }),
      el('thead', {}, [el('tr', {}, ['process', 'count', 'memory'].map((h) => el('th', { text: h, attrs: { scope: 'col' } })))])]);
    const tb = el('tbody');
    for (const p of procs) tb.appendChild(el('tr', {}, [el('td', { text: p.name }), el('td', { cls: 'mono', text: String(p.count) }), el('td', { cls: 'mono', text: `${p.mb} MB` })]));
    t.appendChild(tb);
    box.appendChild(el('div', { cls: 'tbl-wrap' }, [t]));
  } else box.appendChild(el('p', { cls: 'muted', text: 'No watched processes running.' }));
  const dock = m.docker || [];
  if (dock.length) {
    box.appendChild(el('h3', { cls: 'sub-h', text: 'Docker' }));
    const ul = el('ul', { cls: 'plain mono small' });
    for (const d of dock) ul.appendChild(el('li', { text: typeof d === 'string' ? d : JSON.stringify(d) }));
    box.appendChild(ul);
  }
}

export function renderOverview(box, o) {
  clear(box);
  const kv = el('dl', { cls: 'kv' });
  const add = (k, v) => { kv.appendChild(el('dt', { text: k })); kv.appendChild(v instanceof Node ? el('dd', {}, [v]) : el('dd', { cls: 'mono', text: v })); };
  add('Branch', o.branch ? el('span', { cls: 'with-icon mono' }, [icon('git-branch'), el('span', { text: o.branch })]) : 'n/a');
  add('Uncommitted files', String(o.dirty ?? '?'));
  box.appendChild(kv);
  if (o.stop) box.appendChild(el('p', { cls: 'stop-marker', attrs: { role: 'status' } }, [icon('alert'), el('span', { text: 'STOP file present' })]));
  const commits = o.commits || [];
  if (commits.length) {
    box.appendChild(el('h3', { cls: 'sub-h', text: 'Last commits' }));
    const ul = el('ul', { cls: 'plain mono small commits' });
    for (const c of commits) ul.appendChild(el('li', { text: typeof c === 'string' ? c : [c.hash || c.sha, c.subject || c.message].filter(Boolean).join(' ') }));
    box.appendChild(ul);
  }
}

const OK_RE = /^(pass(ed)?|ok|done|complete(d)?|success)$/i;
const BAD_RE = /^(fail(ed)?|blocked|error)$/i;

export function renderLedger(box, o) {
  clear(box);
  const lines = (o.ledger || []).filter((l) => l.trim());
  if (!lines.length) { box.appendChild(el('p', { cls: 'muted', text: 'Ledger is empty.' })); return; }
  const rows = lines.filter((l, i) => !(i === 1 && /^[\s|:-]+$/.test(l))).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const t = el('table', { cls: 'tbl' });
  rows.forEach((cells, idx) => {
    const tr = el('tr');
    cells.forEach((c) => {
      if (idx === 0) tr.appendChild(el('th', { text: c, attrs: { scope: 'col' } }));
      else if (OK_RE.test(c)) tr.appendChild(el('td', {}, [stateBadge('COMPLETED', c)]));
      else if (BAD_RE.test(c)) tr.appendChild(el('td', {}, [stateBadge('FAILED', c)]));
      else tr.appendChild(el('td', { text: c }));
    });
    (idx === 0 ? t.appendChild(el('thead')) : (t.tBodies[0] || t.appendChild(el('tbody')))).appendChild(tr);
  });
  box.appendChild(el('div', { cls: 'tbl-wrap' }, [t]));
}

export function renderChain(box, o) {
  const lines = o.chain || [];
  const text = lines.length ? lines.join('\n') : 'Chain log is empty or not configured.';
  let pre = box.querySelector('pre');
  if (!pre) { clear(box); pre = el('pre', { cls: 'log', attrs: { tabindex: 0, role: 'region', 'aria-label': 'Chain log tail' } }); box.appendChild(pre); }
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
  if (pre.textContent !== text) pre.textContent = text;
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

export function renderLogs(box, logs) {
  clear(box);
  if (!logs.length) { box.appendChild(el('p', { cls: 'muted', text: 'No live log files configured or found.' })); return; }
  for (const f of logs) {
    const writing = f.age < 30;
    const head = el('div', { cls: 'log-head' }, [
      el('span', { cls: 'mono', text: f.name }),
      tagBadge(writing ? 'running' : 'idle', writing ? 'writing now' : `idle ${fmtAge(f.age)}`, writing ? 'running' : 'idle'),
      el('span', { cls: 'mono muted', text: fmtBytes(f.size) }),
    ]);
    box.appendChild(head);
    if (f.tail && f.tail.length) box.appendChild(el('pre', { cls: 'log', text: f.tail.join('\n'), attrs: { tabindex: 0, role: 'region', 'aria-label': `Tail of ${f.name}` } }));
  }
}

/** Attempt state from the v2 `state` field, else derived like the old page did. */
export function attemptState(r) {
  if (r.state) return normalizeState(r.state);
  if (r.end === null || r.end === undefined) return 'RUNNING';
  if (r.status === 'PASS') return 'COMPLETED';
  if (r.status || r.exit) return 'FAILED';
  return 'UNKNOWN';
}

export function renderAttempts(box, rows, onOpen) {
  clear(box);
  if (!rows.length) { box.appendChild(el('p', { cls: 'muted', text: 'No attempts recorded yet.' })); return; }
  const t = el('table', { cls: 'tbl' }, [el('caption', { cls: 'sr-only', text: 'Attempts, newest first' }),
    el('thead', {}, [el('tr', {}, ['part', '#', 'model', 'took', 'result', 'out tokens'].map((h) => el('th', { text: h, attrs: { scope: 'col' } })))])]);
  const tb = el('tbody');
  const nowSec = Date.now() / 1000;
  for (const r of rows.slice().reverse()) {
    const st = attemptState(r);
    const resText = r.end === null || r.end === undefined ? 'running' : (r.status || `exit ${r.exit}`);
    const partCell = r.sid
      ? el('td', {}, [el('button', { cls: 'link-btn', attrs: { type: 'button', title: 'Open this attempt’s session' }, text: String(r.part), on: { click: () => onOpen(r.sid) } })])
      : el('td', { text: String(r.part) });
    const took = r.start ? fmtDuration((r.end || nowSec) - r.start) : '';
    tb.appendChild(el('tr', { cls: r.sid ? 'row-link' : '', on: r.sid ? { click: (e) => { if (!e.target.closest('button')) onOpen(r.sid); } } : undefined }, [
      partCell,
      el('td', { cls: 'mono', text: String(r.n ?? '') }),
      el('td', { cls: 'mono', text: `${r.model || ''}${r.effort ? `/${r.effort}` : ''}` }),
      el('td', { cls: 'mono', text: took }),
      el('td', {}, [stateBadge(st, resText), el('span', { cls: 'res-text mono', text: resText })]),
      el('td', { cls: 'mono', text: r.usage_total ? fmtTok(r.usage_total.out) : '-' }),
    ]));
  }
  t.appendChild(tb);
  box.appendChild(el('div', { cls: 'tbl-wrap' }, [t]));
}
