// DOM helpers. Data is only ever written with textContent / createTextNode / setAttribute.
// innerHTML and friends are deliberately never used (transcript content is untrusted).

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** el('div', {cls, text, attrs, data, on}, [children]) */
export function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  if (props.cls) e.className = props.cls;
  if (props.text !== undefined && props.text !== null) e.textContent = props.text;
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : String(v));
  if (props.data) for (const [k, v] of Object.entries(props.data)) e.dataset[k] = String(v);
  if (props.on) for (const [k, fn] of Object.entries(props.on)) e.addEventListener(k, fn);
  for (const c of [].concat(children)) if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return e;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setIcon(svg, name) {
  const use = svg.querySelector('use');
  if (use) use.setAttribute('href', `/static/icons.svg#i-${name}`);
}

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/static/icons.svg#i-${name}`);
  use.setAttributeNS(XLINK_NS, 'xlink:href', `/static/icons.svg#i-${name}`);
  svg.appendChild(use);
  return svg;
}

/** Button with an icon and optional visible label. Icon-only buttons need `label` as the accessible name. */
export function button({ icon: ic, text, label, cls = '', title, on, attrs = {}, id }) {
  const b = el('button', { cls: `btn ${cls}`.trim(), attrs: { type: 'button', ...attrs, 'aria-label': text ? undefined : label, title: title || (text ? undefined : label) }, on });
  if (id) b.id = id;
  if (ic) b.appendChild(icon(ic));
  if (text) b.appendChild(el('span', { text }));
  return b;
}

export const STATE_ICON = { RUNNING: 'running', IDLE: 'idle', COMPLETED: 'completed', FAILED: 'failed', UNKNOWN: 'unknown' };

/** State badge: icon + text, never colour alone. */
export function stateBadge(state, tip) {
  const s = STATE_ICON[state] ? state : 'UNKNOWN';
  const b = el('span', { cls: `badge st-${s.toLowerCase()}`, data: { state: s } });
  if (tip) b.title = tip;
  b.appendChild(icon(STATE_ICON[s]));
  b.appendChild(el('span', { text: s }));
  return b;
}

/** Generic badge with an icon and text (stale, partial, ...). */
export function tagBadge(kind, text, iconName, tip) {
  const b = el('span', { cls: `badge tag-${kind}` });
  if (tip) b.title = tip;
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(el('span', { text }));
  return b;
}

// ---- live region and toast -------------------------------------------------

let liveNode = null;
let toastNode = null;
let toastTimer = null;

export function initFeedback(live, toast) { liveNode = live; toastNode = toast; }

/** Politely announce a state change to assistive tech. */
export function announce(msg) {
  if (!liveNode) return;
  liveNode.textContent = '';
  setTimeout(() => { liveNode.textContent = msg; }, 30);
}

/** Visible short notice (also announced). */
export function notify(msg) {
  announce(msg);
  if (!toastNode) return;
  toastNode.textContent = msg;
  toastNode.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastNode.hidden = true; }, 2500);
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea fallback */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  if (prev && prev.focus) prev.focus({ preventScroll: true });
  return ok;
}
