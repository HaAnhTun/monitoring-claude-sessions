// The in-page script of `measure` (WP-122, CAW-35). It runs in the browser as a string, because the e2e project has no DOM types,
// and answers one object; `measure.ts` checks the answer. Text facts follow design 05 section 7.3:
//   - (text with no room in a clipping ancestor, or with an effective opacity below 5 percent, is not on the screen and is not judged)
//   - `lowContrastTexts`, `worstContrast`, `worstContrastNode`: every visible text node, its colour from the computed style of its
//     parent (opacity of the chain applied), its background from the nearest ancestors with an opaque background (partial alpha
//     composited, the page canvas below them); 4.5:1, or 3:1 for text of at least 24 px or 18.66 px bold. Skipped: disabled and
//     aria-disabled controls, `.sr-only`, svg and `.xterm`. Background images and gradients are not read (a limit of the method).
//   - `nonMonoText`: text elements whose first computed font family is not the first family of `--mono` (`Cascadia Mono` when the
//     page has no `--mono`), outside `.xterm` and svg.
//   - `tinyText`: visible text elements with a computed size below 11 px (not `.sr-only`, not svg).
//   - `clippedText`: elements with text whose vertical overflow is hidden while their content is more than 1 px taller than their
//     box (a cut diacritic), except line-clamp boxes, `.sr-only` and `.xterm`.
//   - `terminal`: `{ cols, rows, top, heightRatio }` of the first `[data-terminal][data-cols][data-rows]`, else null.
// Hidden elements are ignored everywhere. The node description names the element and a short start of its text, so that a finding
// can be found in the page.

/** The elements that count as rows of a page: `tbody tr`, `[role="row"]` outside a header, and any element a page marks with `data-row`. */
export const ROW_SELECTOR = 'main tbody tr, main [role="row"]:not(thead *), main [data-row]';

/** The first family of `--mono` when a page does not define it (the MTOP stack starts with it). */
export const MONO_FALLBACK = 'Cascadia Mono';

/** Text this size or larger needs 3:1 instead of 4.5:1 (WCAG large text: 18 pt, or 14 pt bold). */
export const LARGE_TEXT_PX = 24;
export const LARGE_BOLD_TEXT_PX = 18.66;
export const MIN_TEXT_PX = 11;

export const MEASURE_SCRIPT = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const round = (n) => Math.round(n * 10) / 10;
  const main = document.querySelector('main');

  const rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW_SELECTOR)})).filter(visible);
  let maxRowHeight = 0;
  for (const row of rows) maxRowHeight = Math.max(maxRowHeight, row.getBoundingClientRect().height);
  const firstRowTop = rows.length === 0 ? null : round(rows[0].getBoundingClientRect().top + window.scrollY);

  const tabbable = Array.from(
    document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]'),
  ).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('tabindex') === '-1') return false;
    if (el.tagName === 'INPUT' && el.getAttribute('type') === 'hidden') return false;
    if (el.closest('[inert], [hidden]')) return false;
    return visible(el) || el.matches('a, button, input, select, textarea');
  });
  let tabStopsBeforeMain = 0;
  if (main) {
    for (const el of tabbable) {
      if (main.contains(el)) continue;
      if (el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING && visible(el)) tabStopsBeforeMain += 1;
    }
  }

  let clippedColumns = 0;
  for (const table of document.querySelectorAll('main table')) {
    if (!visible(table)) continue;
    let box = table.parentElement;
    while (box && box !== document.body) {
      const overflowX = getComputedStyle(box).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden') break;
      box = box.parentElement;
    }
    const limit = Math.min(window.innerWidth, box && box !== document.body ? box.getBoundingClientRect().right : window.innerWidth);
    for (const cell of table.querySelectorAll('thead th')) {
      if (!visible(cell)) continue;
      const r = cell.getBoundingClientRect();
      const s = getComputedStyle(cell);
      const cutByBox = r.right > limit + 1;
      const textCut = s.overflow !== 'visible' && cell.scrollWidth > cell.clientWidth + 1;
      if (cutByBox || textCut) clippedColumns += 1;
    }
  }

  // ---- text: colours ----
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const parsed = new Map();
  // Any CSS colour syntax (rgb, hsl, oklch, color-mix, named) becomes [r, g, b, a] through the canvas, which converts it to sRGB.
  const parseColor = (text) => {
    const known = parsed.get(text);
    if (known) return known;
    let result = [0, 0, 0, 0];
    const direct = text.indexOf('rgb') === 0 ? text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')) : '';
    const parts = direct === '' ? [] : direct.replace('/', ' ').split(/[ ,]+/).filter((p) => p !== '');
    if (parts.length >= 3 && parts.slice(0, 3).every((p) => Number.isFinite(Number(p)))) {
      // the common computed form: exact, with no rounding of a translucent colour
      const a = parts.length > 3 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3])) : 1;
      result = [Number(parts[0]), Number(parts[1]), Number(parts[2]), Number.isFinite(a) ? a : 1];
    } else if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000000';
      context.fillStyle = text;
      context.fillRect(0, 0, 1, 1);
      const d = context.getImageData(0, 0, 1, 1).data;
      // getImageData premultiplies nothing for an opaque pixel; for a translucent one the canvas holds the straight colour over transparent black
      const alpha = d[3] / 255;
      result = alpha === 0 ? [0, 0, 0, 0] : [d[0], d[1], d[2], alpha];
    }
    parsed.set(text, result);
    return result;
  };
  const over = (top, below) => {
    const a = top[3] + below[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + below[i] * below[3] * (1 - top[3])) / a).concat([a]);
  };
  const root = document.documentElement;
  const rootScheme = getComputedStyle(root).colorScheme || '';
  const canvasColor = rootScheme.indexOf('dark') >= 0 && rootScheme.indexOf('light') < 0 ? [18, 18, 18, 1] : [255, 255, 255, 1];
  const backgroundOf = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color[3] > 0) layers.push(color);
      if (color[3] >= 1) break;
    }
    let result = layers.length > 0 && layers[layers.length - 1][3] >= 1 ? layers.pop() : canvasColor;
    while (layers.length > 0) result = over(layers.pop(), result);
    return result;
  };
  const opacityOf = (el) => {
    let alpha = 1;
    for (let node = el; node; node = node.parentElement) alpha *= Number(getComputedStyle(node).opacity);
    return alpha;
  };
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  const ratio = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const describe = (el, text) => {
    let name = el.tagName.toLowerCase();
    if (el.id) name += '#' + el.id;
    const classes = Array.from(el.classList).slice(0, 2);
    for (const c of classes) name += '.' + c;
    const shown = text.length > 32 ? text.slice(0, 32) + '...' : text;
    return name + ' "' + shown + '"';
  };

  // ---- text: the visible text nodes and their elements ----
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TITLE: 1, HEAD: 1 };
  const hiddenFor = (el, selector) => !!el.closest(selector);
  // Text that an ancestor with hidden or clipped overflow leaves no room for (a collapsed rail label) is not on the screen.
  const clippedAway = (el) => {
    const r = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const b = node.getBoundingClientRect();
      const wide = s.overflowX !== 'visible' && (r.right <= b.left + 0.5 || r.left >= b.right - 0.5);
      const high = s.overflowY !== 'visible' && (r.bottom <= b.top + 0.5 || r.top >= b.bottom - 0.5);
      if (wide || high) return true;
    }
    return false;
  };
  let lowContrastTexts = 0;
  let worstContrast = null;
  let worstContrastNode = null;
  const monoCss = getComputedStyle(root).getPropertyValue('--mono');
  const firstFamily = (list) => (list.split(',')[0] || '').replace(/["']/g, '').trim().toLowerCase();
  const monoFirst = monoCss.trim() === '' ? ${JSON.stringify(MONO_FALLBACK.toLowerCase())} : firstFamily(monoCss);
  const nonMono = new Set();
  const tiny = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.nodeValue || '').trim();
    const el = node.parentElement;
    if (text === '' || !el || SKIP_TAGS[el.tagName] || !visible(el)) continue;
    if (hiddenFor(el, '.sr-only') || clippedAway(el)) continue;
    const inSvg = hiddenFor(el, 'svg');
    const inTerminal = hiddenFor(el, '.xterm');
    const style = getComputedStyle(el);
    const size = parseFloat(style.fontSize);
    if (!inSvg && size < ${MIN_TEXT_PX}) tiny.add(el);
    if (inSvg || inTerminal) continue;
    if (firstFamily(style.fontFamily) !== monoFirst) nonMono.add(el);
    if (hiddenFor(el, '[disabled], [aria-disabled="true"]')) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const bg = backgroundOf(el);
    const fgRaw = parseColor(style.color);
    const alpha = fgRaw[3] * opacityOf(el);
    if (alpha < 0.05) continue;
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], alpha], bg);
    const value = ratio(fg, bg);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const large = size >= ${LARGE_TEXT_PX} || (size >= ${LARGE_BOLD_TEXT_PX} && weight >= 700);
    if (value < (large ? 3 : 4.5)) lowContrastTexts += 1;
    if (worstContrast === null || value < worstContrast) {
      worstContrast = value;
      worstContrastNode = describe(el, text);
    }
  }

  // ---- clipped text: a vertical clip of an element with text ----
  let clippedText = 0;
  for (const el of document.body.querySelectorAll('*')) {
    if (SKIP_TAGS[el.tagName] || el instanceof SVGElement) continue;
    const style = getComputedStyle(el);
    if (style.overflowY !== 'hidden' && style.overflowY !== 'clip') continue;
    if ((el.textContent || '').trim() === '') continue;
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const clamp = style.getPropertyValue('-webkit-line-clamp');
    if (clamp !== '' && clamp !== 'none') continue;
    if (hiddenFor(el, '.sr-only') || hiddenFor(el, '.xterm') || !visible(el)) continue;
    clippedText += 1;
  }

  // ---- the terminal ----
  let terminal = null;
  const host = document.querySelector('[data-terminal][data-cols][data-rows]');
  if (host) {
    const cols = Number(host.getAttribute('data-cols'));
    const rowCount = Number(host.getAttribute('data-rows'));
    if (Number.isFinite(cols) && Number.isFinite(rowCount)) {
      const r = host.getBoundingClientRect();
      terminal = {
        cols,
        rows: rowCount,
        top: round(r.top + window.scrollY),
        heightRatio: Math.round((r.height / window.innerHeight) * 1000) / 1000,
      };
    }
  }

  return {
    pageOverflowX: Math.max(0, doc.scrollWidth - doc.clientWidth),
    maxRowHeight: round(maxRowHeight),
    tabStopsBeforeMain,
    firstRowTop,
    clippedColumns,
    lowContrastTexts,
    worstContrast: worstContrast === null ? null : Math.round(worstContrast * 100) / 100,
    worstContrastNode,
    nonMonoText: nonMono.size,
    tinyText: tiny.size,
    clippedText,
    terminal,
  };
})()`;
