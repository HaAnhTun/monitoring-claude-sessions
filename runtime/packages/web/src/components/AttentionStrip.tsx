import type { Overview } from '@mcs/shared';
import { useMemo } from 'react';

import { useT } from '../i18n/context.ts';
import type { MessageKey } from '../i18n/types.ts';
import {
  ATTENTION_TILES,
  attentionFigures,
  type AttentionFigure,
  type AttentionFilter,
  type AttentionRow,
  type AttentionTile,
} from '../lib/sessions-attention.ts';
import { SummaryStrip, type SummaryTile, type SummaryTone } from './SummaryStrip.tsx';

export interface AttentionStripProps {
  /** The server metrics; a tile uses its metric when the overview has one with a value. */
  overview: Pick<Overview, 'metrics'> | null | undefined;
  /** The rows of the list that are loaded now: what a tile counts when the server has no metric for it. */
  loadedRows: readonly AttentionRow[];
  /** No page is left on the server, so the counts of the rows are exact; otherwise they are lower bounds. */
  complete: boolean;
  /** The tile that is pressed, if any. */
  filter: AttentionFilter;
  /** Called with the tile that was pressed, or with null when the pressed tile was pressed again. */
  onFilter: (next: AttentionFilter) => void;
}

const TONES: Readonly<Record<AttentionTile, SummaryTone>> = {
  working: 'running',
  quiet: 'quiet',
  errors: 'failed',
  waiting: 'waiting',
};

const LABEL_KEYS = {
  working: 'attention.working',
  quiet: 'attention.quiet',
  errors: 'attention.errors',
  waiting: 'attention.waiting',
} as const satisfies Readonly<Record<AttentionTile, MessageKey>>;

const TIP_KEYS = {
  working: 'attention.working.tip',
  quiet: 'attention.quiet.tip',
  errors: 'attention.errors.tip',
  waiting: 'attention.waiting.tip',
} as const satisfies Readonly<Record<AttentionTile, MessageKey>>;

/**
 * The four toggle tiles above the session list (ADR 0073 decision 7, review R-11): Working, Quiet (inferred), With errors and
 * Waiting for input. A tile shows the server metric when the overview returns one, else the count of the loaded rows: exact when
 * the whole list is loaded, `N+` with an explanation when more pages exist (deviation D-30 of ADR 0074 decision 8). The strip is
 * drawn as soon as the page renders it: a figure that is not known yet is a dash, never 0.
 */
export function AttentionStrip({ overview, loadedRows, complete, filter, onFilter }: AttentionStripProps) {
  const t = useT();
  const figures = useMemo(() => attentionFigures(overview, loadedRows, { complete }), [overview, loadedRows, complete]);

  function sourceNote(figure: AttentionFigure): string {
    if (figure.source === 'server') return t('attention.source.server');
    if (figure.source === 'none' || figure.value === null) return '';
    return figure.lowerBound
      ? t('attention.source.atLeast', { count: figure.value, loaded: figure.loaded })
      : t('attention.source.loaded', { loaded: figure.loaded });
  }

  const tiles: SummaryTile[] = ATTENTION_TILES.map((tile) => {
    const figure = figures[tile];
    return {
      id: tile,
      label: t(LABEL_KEYS[tile]),
      value: figure.value,
      tone: TONES[tile],
      lowerBound: figure.lowerBound,
      tip: [t(TIP_KEYS[tile]), sourceNote(figure)].filter((part) => part !== '').join(' '),
      pressed: filter === tile,
      onToggle: () => {
        onFilter(filter === tile ? null : tile);
      },
    };
  });
  return <SummaryStrip tiles={tiles} label={t('attention.label')} />;
}
