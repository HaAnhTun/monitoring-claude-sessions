import { useState, type ReactNode } from 'react';

/** Expanded text is cut here; the rest stays reachable through Copy (04-ui.md section 8, ADR 0034). */
export const MAX_EXPANDED_CHARS = 200_000;
/** Legacy clamp of a collapsed text. */
export const DEFAULT_CLAMP_CHARS = 1500;

/** The first `max` UTF-16 units of `text`, never ending in the middle of a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export interface ClampedTextProps {
  text: string;
  clampChars?: number;
  render: (text: string) => ReactNode;
  /** Stable id: the button controls `<id>-body` and a controlling parent identifies the text by it. */
  id: string;
  /** Controlled state (the parent keeps it keyed by row, so it survives updates). Omit for local state. */
  expanded?: boolean;
  onToggle?: (id: string, expanded: boolean) => void;
}

/** Long text collapsed to `clampChars` with a "Show more" / "Show less" button (legacy, must-preserve #25). */
export function ClampedText({
  text,
  clampChars = DEFAULT_CLAMP_CHARS,
  render,
  id,
  expanded,
  onToggle,
}: ClampedTextProps) {
  const [local, setLocal] = useState(false);
  const isExpanded = expanded ?? local;
  const bodyId = `${id}-body`;
  if (text.length <= clampChars) {
    return (
      <div id={bodyId} className="clamped">
        {render(text)}
      </div>
    );
  }
  const tooLong = isExpanded && text.length > MAX_EXPANDED_CHARS;
  const shown = isExpanded ? clipText(text, MAX_EXPANDED_CHARS) : clipText(text, clampChars);
  return (
    <div className="clamped">
      <div id={bodyId}>{render(shown)}</div>
      {tooLong ? (
        <p className="clamped__note muted small">
          {`Text too long to show here (${String(text.length)} characters). Use Copy.`}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn-quiet clamped__toggle"
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        onClick={() => {
          const next = !isExpanded;
          setLocal(next);
          onToggle?.(id, next);
        }}
      >
        {isExpanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  );
}
