// Tiny, safe Markdown subset (parser half of legacy modules/markdown.js, 04 sections 8 and 10): fenced code blocks,
// inline code and paragraphs. The parser returns plain data; components/Markdown.tsx renders it with React text nodes, so
// no HTML is ever parsed and transcript text such as "<img onerror=...>" is shown literally.

export type MdInline = { type: 'text'; text: string } | { type: 'code'; text: string };

export type MdBlock = { type: 'code'; lang: string; text: string } | { type: 'p'; inline: MdInline[] };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Text -> blocks. Never throws; null and undefined are empty text. */
export function parseMarkdown(text: string | null | undefined): MdBlock[] {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = (): void => {
    const body = para.join('\n').replace(/^\n+|\n+$/g, '');
    para = [];
    if (body.trim() !== '') blocks.push({ type: 'p', inline: parseInline(body) });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const m = FENCE_OPEN.exec(line);
    const fence = m?.[1];
    if (m !== null && fence !== undefined) {
      flush();
      const lang = (m[2] ?? '').trim().split(/\s+/)[0]?.slice(0, 24) ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const t = current.trim();
        if (t.length >= fence.length && t.replaceAll(fence.charAt(0), '') === '') break;
        body.push(current);
        i += 1;
      }
      blocks.push({ type: 'code', lang, text: body.join('\n') });
    } else if (line.trim() === '') {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** Splits a paragraph into text and inline code spans (a single backtick pair on one line). */
export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    out.push({ type: 'code', text: m[1] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}
