import { memo } from 'react';

import { ClampedText } from '../components/ClampedText.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { Icon } from '../components/Icon.tsx';
import { TagBadge, type Tone } from '../components/TagBadge.tsx';
import { useFormat, useT } from '../i18n/context.ts';
import { toolDurationSec, unitSig, type Unit, type UnitStatus } from '../lib/timeline-model.ts';
import { EntryIndexButton, EntryTime } from './TranscriptRow.tsx';

export interface ToolUnitRowProps {
  unit: Unit;
  hidden: boolean;
  /** Open state of the `<details>`, kept by the viewer in a set keyed by session, agent and row (must-preserve #24). */
  open: boolean;
  onOpenChange: (key: string, open: boolean) => void;
  expandedInput: boolean;
  expandedResult: boolean;
  onToggleExpanded: (id: string, expanded: boolean) => void;
  /** The Results kind is off: the result block is hidden by CSS (`hide-result`). */
  hideResult: boolean;
  isTarget: boolean;
  /** The clock for a running tool; the viewer passes 0 for finished tools so they never re-render on the tick. */
  nowMs: number;
}

/** A run of 16 or more digits: a number that the JSON round trip can round (above 2^53 or with a long fraction). */
const LONG_NUMBER = /\d{16}/;

/**
 * `JSON.parse` + two-space `JSON.stringify`, or the raw text when it is not JSON (the server clips tool input) or when
 * the round trip could change a number literal, so the shown input never differs from the real one.
 */
export function prettyInput(input: string): string {
  if (LONG_NUMBER.test(input)) return input;
  try {
    const parsed: unknown = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}

const PILL = {
  active: { tone: 'running', word: 'transcript.tool.status.active' },
  completed: { tone: 'ok', word: 'transcript.tool.status.completed' },
  failed: { tone: 'failed', word: 'transcript.tool.status.failed' },
} as const satisfies Record<UnitStatus, { tone: Tone; word: `transcript.tool.status.${UnitStatus}` }>;

function ToolUnitRowView({
  unit,
  hidden,
  open,
  onOpenChange,
  expandedInput,
  expandedResult,
  onToggleExpanded,
  hideResult,
  isTarget,
  nowMs,
}: ToolUnitRowProps) {
  const t = useT();
  const format = useFormat();
  const { ev, result, key } = unit;
  const status = unit.status ?? 'active';
  const seconds = toolDurationSec(unit, nowMs);
  const pill = PILL[status];
  const word = t(pill.word);
  const pillText =
    seconds === null ? word : t('transcript.tool.statusTime', { status: word, time: format.duration(seconds) });
  const failed = status === 'failed';
  const className = `tr tr--tool${failed ? ' tr--error' : ''}${isTarget ? ' is-target' : ''}`;
  return (
    <li className={className} id={`row-${key}`} data-row-key={key} hidden={hidden} tabIndex={-1}>
      <details
        className={`tu tu--${status}${hideResult ? ' hide-result' : ''}`}
        open={open}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          if (next !== open) onOpenChange(key, next);
        }}
      >
        <summary className="tu-summary" aria-expanded={open}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="tu-chevron" />
          <TagBadge tone={pill.tone} icon={failed ? 'alert' : undefined}>
            {pillText}
          </TagBadge>
          <span className="tu-name">{ev.name ?? t('transcript.tool.unnamed')}</span>
          <span className="tu-line muted" title={ev.summary}>
            {ev.summary ?? ''}
          </span>
          <span className="tr-index muted small">{`#${String(ev.i)}`}</span>
          <EntryTime entry={ev} />
        </summary>
        <div className="tu-body">
          <div className="tu-actions">
            {/* The summary is one control; a button inside it would nest controls, so the index copy button lives here. */}
            <EntryIndexButton entry={ev} />
            <CopyButton text={ev.input ?? ''} label={t('transcript.tool.copyInput')} compact />
            {ev.id === undefined ? null : <CopyButton text={ev.id} label={t('transcript.tool.copyId')} compact />}
          </div>
          {ev.input === undefined || ev.input === '' ? null : (
            <ClampedText
              id={`${key}-input`}
              text={prettyInput(ev.input)}
              expanded={expandedInput}
              onToggle={onToggleExpanded}
              render={(shown) => <pre className="tr-pre tu-input">{shown}</pre>}
            />
          )}
          {result === null ? null : (
            <div className={failed ? 'tu-result tu-result--err' : 'tu-result'}>
              <div className="tu-result__label small">
                {failed ? t('transcript.tool.resultError') : t('transcript.tool.result')}
              </div>
              <ClampedText
                id={`${key}-result`}
                text={result.text ?? ''}
                expanded={expandedResult}
                onToggle={onToggleExpanded}
                render={(shown) => <pre className="tr-pre tu-output">{shown}</pre>}
              />
            </div>
          )}
        </div>
      </details>
    </li>
  );
}

/** Only an active tool row depends on the clock (`nowMs`); everything else re-renders on its signature or when its entries are replaced (4.4.3 rule 1). */
export const ToolUnitRow = memo(
  ToolUnitRowView,
  (a, b) =>
    a.unit.key === b.unit.key &&
    unitSig(a.unit) === unitSig(b.unit) &&
    a.unit.ev === b.unit.ev &&
    a.unit.result === b.unit.result &&
    a.hidden === b.hidden &&
    a.open === b.open &&
    a.onOpenChange === b.onOpenChange &&
    a.expandedInput === b.expandedInput &&
    a.expandedResult === b.expandedResult &&
    a.onToggleExpanded === b.onToggleExpanded &&
    a.hideResult === b.hideResult &&
    a.isTarget === b.isTarget &&
    a.nowMs === b.nowMs,
);
