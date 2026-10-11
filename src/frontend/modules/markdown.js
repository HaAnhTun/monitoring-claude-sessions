// Tiny, safe Markdown subset: fenced code blocks, inline code, paragraphs.
// The output is built with createElement + textContent only. No HTML is ever parsed,
// so transcript text such as "<img onerror=...>" is shown literally.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** text -> [{type:'code', lang, text} | {type:'p', inline:[{type:'text'|'code', text}]}] */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    const body = para.join('\n').replace(/^\n+|\n+$/g, '');
    para = [];
    if (body.trim()) blocks.push({ type: 'p', inline: parseInline(body) });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (m) {
      flush();
      const fence = m[1];
      const lang = (m[2].trim().split(/\s+/)[0] || '').slice(0, 24);
      const body = [];
      i += 1;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.length >= fence.length && t[0] === fence[0] && [...t].every((c) => c === fence[0])) break;
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') });
    } else if (lines[i].trim() === '') {
      flush();
    } else {
      para.push(lines[i]);
    }
  }
  flush();
  return blocks;
}

export function parseInline(s) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'code', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

function node(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Render to a DocumentFragment (or whatever doc.createDocumentFragment gives). */
export function renderMarkdown(text, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const b of parseMarkdown(text)) {
    if (b.type === 'code') {
      const wrap = node(doc, 'div', 'md-code');
      if (b.lang) wrap.appendChild(node(doc, 'span', 'md-lang', b.lang));
      const pre = node(doc, 'pre');
      pre.appendChild(node(doc, 'code', '', b.text));
      wrap.appendChild(pre);
      frag.appendChild(wrap);
    } else {
      const p = node(doc, 'p', 'md-p');
      for (const part of b.inline) {
        p.appendChild(part.type === 'code' ? node(doc, 'code', 'md-inline', part.text) : doc.createTextNode(part.text));
      }
      frag.appendChild(p);
    }
  }
  return frag;
}
