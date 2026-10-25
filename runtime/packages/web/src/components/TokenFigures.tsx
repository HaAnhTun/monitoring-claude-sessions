import type { TokenUsage } from '@mcs/shared';

import { useFormat, useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import { tokenParts } from '../lib/format.ts';
import { Popover } from './Popover.tsx';
import { TagBadge } from './TagBadge.tsx';

/** The three figures of ADR 0074 decision 5. Input (new) is input plus cache write. */
export type TokenFigureId = 'output' | 'inputNew' | 'cacheRead';

const FIGURE_IDS: readonly TokenFigureId[] = ['output', 'inputNew', 'cacheRead'];

const LABEL_KEYS = {
  output: 'tokens.output',
  inputNew: 'tokens.inputNew',
  cacheRead: 'tokens.cacheRead',
} as const satisfies Readonly<Record<TokenFigureId, MessageKey>>;

export interface TokenFiguresProps {
  /** Null (or usage that is unavailable) is "not available", never 0. */
  usage: TokenUsage | null;
  /**
   * `cell`: one compact figure of a table row (pick it with `figure`); `tiles`: the three figures as headline numbers;
   * `line`: the three figures in one line.
   */
  variant: 'cell' | 'tiles' | 'line';
  /** The figure of a `cell`. Default `output`. */
  figure?: TokenFigureId | undefined;
  /** The numbers include the subagents of the session. */
  includesSubagents?: boolean | undefined;
  /** Which figures `tiles` and `line` draw, in this order; all three when omitted. The breakdown popover still lists every part. */
  figures?: readonly TokenFigureId[] | undefined;
}

interface Resolved {
  /** False for null usage and for usage that the monitor could not read at all: every figure is unknown. */
  available: boolean;
  figures: Record<TokenFigureId, number | null>;
  input: number | null;
  cacheWrite: number | null;
  /** The numbers are a lower bound; the share that was scanned when it is known. */
  lowerBound: { scannedPct: number | null } | null;
}

function resolve(usage: TokenUsage | null): Resolved {
  if (usage === null || usage.completeness === 'unavailable') {
    return {
      available: false,
      figures: { output: null, inputNew: null, cacheRead: null },
      input: null,
      cacheWrite: null,
      lowerBound: null,
    };
  }
  const parts = tokenParts(usage);
  return {
    available: true,
    figures: { output: parts?.out ?? null, inputNew: parts?.newInput ?? null, cacheRead: parts?.cacheRead ?? null },
    input: usage.input,
    cacheWrite: usage.cacheCreation,
    lowerBound: usage.completeness === 'partial' || usage.lowerBound ? { scannedPct: usage.scannedPct } : null,
  };
}

function NotAvailable() {
  const t = useT();
  return (
    <span className="token-figures__na" title={t('tokens.notAvailable')}>
      <span aria-hidden="true">{t('tokens.na')}</span>
      <span className="sr-only">{t('tokens.notAvailable')}</span>
    </span>
  );
}

function Value({ value, title }: { value: number | null; title: string }) {
  const format = useFormat();
  if (value === null) return <NotAvailable />;
  return (
    <span className="token-figures__num" title={title}>
      {format.compact(value)}
    </span>
  );
}

/** What the title of a figure says: the exact number, and for Input (new) the sum it is made of. */
function useTitles(resolved: Resolved): Record<TokenFigureId, string> {
  const t = useT();
  const format = useFormat();
  const { figures, input, cacheWrite } = resolved;
  const exact = (value: number | null): string => (value === null ? '' : format.number(value));
  const inputNewTitle =
    input !== null && cacheWrite !== null && figures.inputNew !== null
      ? t('tokens.inputNewTip', { input: exact(input), cacheWrite: exact(cacheWrite), sum: exact(figures.inputNew) })
      : exact(figures.inputNew);
  return { output: exact(figures.output), inputNew: inputNewTitle, cacheRead: exact(figures.cacheRead) };
}

function LowerBoundTag({ scannedPct }: { scannedPct: number | null }) {
  const t = useT();
  const format = useFormat();
  const tip =
    scannedPct === null
      ? t('tokens.lowerBoundUnknown')
      : t('tokens.lowerBoundScan', { pct: format.percent(scannedPct / 100) });
  return (
    <TagBadge tone="partial" tip={tip}>
      {t('tokens.lowerBound')}
    </TagBadge>
  );
}

/** The breakdown behind the figures: input, cache write, their sum (Input (new)) and cache read, with exact numbers. */
function Breakdown({ resolved }: { resolved: Resolved }) {
  const t = useT();
  const format = useFormat();
  const row = (
    label: 'tokens.input' | 'tokens.cacheWrite' | 'tokens.inputNew' | 'tokens.cacheRead',
    value: number | null,
  ) => (
    <div className="token-figures__row" key={label}>
      <dt>{t(label)}</dt>
      <dd>{value === null ? <NotAvailable /> : format.number(value)}</dd>
    </div>
  );
  return (
    <Popover
      icon="info"
      variant="icon"
      ariaLabel={t('tokens.breakdown')}
      panelLabel={t('tokens.breakdown')}
      align="end"
    >
      <dl className="token-figures__breakdown">
        {row('tokens.input', resolved.input)}
        {row('tokens.cacheWrite', resolved.cacheWrite)}
        {row('tokens.inputNew', resolved.figures.inputNew)}
        {row('tokens.cacheRead', resolved.figures.cacheRead)}
      </dl>
    </Popover>
  );
}

/**
 * The token figures of a session or an agent in the one vocabulary of ADR 0074 decision 5: Output, Input (new) (input plus cache
 * write, the sum in the title) and Cache read. Numbers are compact (`12K`) with the exact value in the title; a number the monitor
 * does not have is "not available", never 0; partial usage carries the "lower bound" tag. New code uses this instead of
 * `TokenLine` and `TokenSummary`. A table cell is plain text, because a popover inside the scrolling wrapper of a table would be
 * clipped; the breakdown is in the title there.
 */
export function TokenFigures({
  usage,
  variant,
  figure = 'output',
  includesSubagents = false,
  figures = FIGURE_IDS,
}: TokenFiguresProps) {
  const t = useT();
  const resolved = resolve(usage);
  const titles = useTitles(resolved);
  const { lowerBound } = resolved;

  if (variant === 'cell') {
    return (
      <span className="token-figures token-figures--cell">
        <Value value={resolved.figures[figure]} title={titles[figure]} />
        {lowerBound === null || resolved.figures[figure] === null ? null : (
          <>
            <span className="token-figures__bound" aria-hidden="true">
              +
            </span>
            <span className="sr-only">{t('tokens.lowerBound')}</span>
          </>
        )}
      </span>
    );
  }

  const note = includesSubagents ? <span className="muted">{t('tokens.inclSubagents')}</span> : null;
  if (variant === 'line') {
    if (!resolved.available) {
      return (
        <div className="token-figures token-figures--line">
          <TagBadge tone="unknown" tip={t('tokens.notAvailable')}>
            {t('tokens.notAvailable')}
          </TagBadge>
        </div>
      );
    }
    return (
      <div className="token-figures token-figures--line">
        {figures.map((id) => (
          <span className="token-figures__item" key={id}>
            <span className="token-figures__label">{t(LABEL_KEYS[id])}</span>
            <Value value={resolved.figures[id]} title={titles[id]} />
          </span>
        ))}
        {lowerBound === null ? null : <LowerBoundTag scannedPct={lowerBound.scannedPct} />}
        {note}
        <Breakdown resolved={resolved} />
      </div>
    );
  }

  return (
    <div className="token-figures token-figures--tiles">
      <dl className="token-figures__grid">
        {figures.map((id) => (
          <div className="token-figures__tile" key={id}>
            <dt>{t(LABEL_KEYS[id])}</dt>
            <dd>
              <Value value={resolved.figures[id]} title={titles[id]} />
            </dd>
          </div>
        ))}
      </dl>
      {lowerBound === null ? null : <LowerBoundTag scannedPct={lowerBound.scannedPct} />}
      {note}
      {resolved.available ? <Breakdown resolved={resolved} /> : null}
    </div>
  );
}
