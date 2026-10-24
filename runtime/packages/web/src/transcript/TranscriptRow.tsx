import type { EntryKind, TranscriptEntry } from '@mcs/shared';
import { memo } from 'react';

import { ClampedText } from '../components/ClampedText.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/icons.ts';
import { Markdown } from '../components/Markdown.tsx';
import { TagBadge } from '../components/TagBadge.tsx';
import { useFormat, useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { unitSig, type Unit } from '../lib/timeline-model.ts';

/** The message of the row label of each kind (`transcript.kind.*`). */
export const ROW_LABEL_KEYS = {
  prompt: 'transcript.kind.prompt',
  say: 'transcript.kind.say',
  think: 'transcript.kind.think',
  tool: 'transcript.kind.tool',
  result: 'transcript.kind.result',
} as const satisfies Record<EntryKind, MessageKey>;

export const ROW_ICONS: Readonly<Record<EntryKind, IconName>> = {
  prompt: 'user',
  say: 'bot',
  think: 'help',
  tool: 'tool',
  result: 'file-text',
};

/** `#12`: a button that copies the entry index (legacy). */
export function EntryIndexButton({ entry }: { entry: TranscriptEntry }) {
  const t = useT();
  return (
    <CopyButton text={String(entry.i)} label={t('transcript.row.copyIndex')} compact>
      {`#${String(entry.i)}`}
    </CopyButton>
  );
}

/** The wall-clock time of an entry; nothing when the record had no timestamp. */
export function EntryTime({ entry }: { entry: TranscriptEntry }) {
  const format = useFormat();
  const clock = format.clock(entry.t);
  if (clock === '') return null;
  return (
    <time className="tr-time muted small" dateTime={entry.t}>
      {clock}
    </time>
  );
}

export interface TranscriptRowProps {
  unit: Unit;
  /** Rows are never unmounted by a filter: scroll, focus and open state survive (4.4.3 rule 1). */
  hidden: boolean;
  /** Whether the clamped text of this row is expanded (kept by the viewer, keyed by row). */
  expanded: boolean;
  /** The row the last jump or error step landed on. */
  isTarget: boolean;
  onToggleExpanded: (id: string, expanded: boolean) => void;
}

function TranscriptRowView({ unit, hidden, expanded, isTarget, onToggleExpanded }: TranscriptRowProps) {
  const t = useT();
  const { ev, key } = unit;
  const text = ev.text ?? '';
  const textId = `${key}-text`;
  const isError = unit.kind === 'result' && ev.err === true;
  // The border colour follows the role of the row (`tr--prompt`, `tr--say`, ...); red is kept for errors (ADR 0071 decision 3).
  const className = `tr tr--${unit.kind}${isError ? ' tr--error' : ''}${isTarget ? ' is-target' : ''}`;
  return (
    <li className={className} id={`row-${key}`} data-row-key={key} hidden={hidden} tabIndex={-1}>
      <div className="tr-head">
        <span className="tr-kind">
          <Icon name={ROW_ICONS[unit.kind]} />
          <span>{t(ROW_LABEL_KEYS[unit.kind])}</span>
        </span>
        {isError ? (
          <TagBadge tone="failed" icon="alert">
            {t('transcript.row.errorTag')}
          </TagBadge>
        ) : null}
        <EntryIndexButton entry={ev} />
        <EntryTime entry={ev} />
        <CopyButton text={text} label={t('transcript.row.copyText')} compact />
      </div>
      <div className="tr-body">
        <ClampedText
          id={textId}
          text={text}
          expanded={expanded}
          onToggle={onToggleExpanded}
          render={(shown) =>
            unit.kind === 'prompt' || unit.kind === 'say' ? (
              <Markdown text={shown} />
            ) : (
              <pre className={unit.kind === 'think' ? 'tr-pre tr-think' : 'tr-pre tr-result'}>{shown}</pre>
            )
          }
        />
      </div>
    </li>
  );
}

/** Re-renders only when the unit (signature or entry identity) or one of its display flags changes (4.4.3 rule 1). */
export const TranscriptRow = memo(
  TranscriptRowView,
  (a, b) =>
    a.unit.key === b.unit.key &&
    unitSig(a.unit) === unitSig(b.unit) &&
    a.unit.ev === b.unit.ev &&
    a.unit.result === b.unit.result &&
    a.hidden === b.hidden &&
    a.expanded === b.expanded &&
    a.isTarget === b.isTarget &&
    a.onToggleExpanded === b.onToggleExpanded,
);
