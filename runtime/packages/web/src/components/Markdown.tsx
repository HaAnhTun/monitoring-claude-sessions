// The safe Markdown subset (04-ui.md section 8, ADR 0034): fenced code blocks, inline code and paragraphs, rendered as React
// text nodes. No HTML string is ever built or parsed, so transcript text such as "<img onerror=...>" is shown literally.
import { useMemo, useState } from 'react';

import { useT } from '../i18n/context.ts';
import { parseMarkdown } from '../lib/markdown.ts';
import { MAX_EXPANDED_CHARS, clipText } from './ClampedText.tsx';
import { CopyButton } from './CopyButton.tsx';

export interface MarkdownProps {
  text: string;
}

/**
 * A code block over this many lines shows its first `SHORT_LINES` and a "Show all N lines" button. The button is one-way and
 * disappears once pressed, so it is a plain action button, not a disclosure (no aria-expanded or aria-controls).
 */
const LONG_BLOCK_LINES = 400;
const SHORT_LINES = 200;

function CodeBlock({ text }: { text: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > LONG_BLOCK_LINES;
  const body = long && !all ? lines.slice(0, SHORT_LINES).join('\n') : text;
  const tooLong = body.length > MAX_EXPANDED_CHARS;
  return (
    <>
      <pre className="md-pre">
        <code>{tooLong ? clipText(body, MAX_EXPANDED_CHARS) : body}</code>
      </pre>
      {tooLong ? <span className="md-note muted small">{t('common.textTooLong', { length: body.length })}</span> : null}
      <span className="md-code__actions">
        {long && !all ? (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setAll(true);
            }}
          >
            {t('transcript.markdown.showAll', { count: lines.length })}
          </button>
        ) : null}
        <CopyButton text={text} label={t('transcript.markdown.copyCode')} compact />
      </span>
    </>
  );
}

/** Renders prompt and say text. Everything else in the transcript is plain text (the policy table of section 8). */
export function Markdown({ text }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <>
      {blocks.map((block, n) =>
        block.type === 'code' ? (
          <div className="md-code" key={n}>
            {block.lang === '' ? null : <span className="md-lang">{block.lang}</span>}
            <CodeBlock text={block.text} />
          </div>
        ) : (
          <p className="md-p" key={n}>
            {block.inline.map((part, m) =>
              part.type === 'code' ? (
                <code className="md-inline" key={m}>
                  {part.text}
                </code>
              ) : (
                part.text
              ),
            )}
          </p>
        ),
      )}
    </>
  );
}
