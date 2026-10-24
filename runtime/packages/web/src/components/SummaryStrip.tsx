import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useFormat, useT } from '../i18n/context.ts';

/** The colour of the dot in front of the label. The word is always there, so a tile never relies on colour alone. */
export type SummaryTone = 'running' | 'quiet' | 'failed' | 'waiting' | 'completed' | 'neutral';

interface SummaryTileBase {
  id: string;
  label: string;
  /** Null is "not known": the tile shows a dash and says "not available", never 0. */
  value: number | null;
  tone: SummaryTone;
  /** The value is "at least" this many (shown as `12+`). */
  lowerBound?: boolean | undefined;
  /** What the figure means and where it was counted; the title of the tile. */
  tip?: string | undefined;
}

/** A link to another page. */
interface LinkTile extends SummaryTileBase {
  href: string;
  onToggle?: never;
  pressed?: never;
}

/** A toggle (`aria-pressed`): pressing it asks the page to filter by it, pressing it again clears the filter. */
interface ToggleTile extends SummaryTileBase {
  href?: never;
  onToggle: () => void;
  pressed?: boolean | undefined;
}

/** A figure that does nothing when pressed. */
interface StaticTile extends SummaryTileBase {
  href?: never;
  onToggle?: never;
  pressed?: never;
}

export type SummaryTile = LinkTile | ToggleTile | StaticTile;

export interface SummaryStripProps {
  tiles: readonly SummaryTile[];
  /** Accessible name of the strip. */
  label?: string | undefined;
}

function Figure({ tile }: { tile: SummaryTile }) {
  const t = useT();
  const format = useFormat();
  if (tile.value === null) {
    return (
      <span className="summary-tile__value summary-tile__value--unknown">
        <span aria-hidden="true">–</span>
        <span className="sr-only">{t('common.notAvailable')}</span>
      </span>
    );
  }
  const text = format.number(tile.value);
  return (
    <span className="summary-tile__value">
      <span aria-hidden="true">{tile.lowerBound === true ? `${text}+` : text}</span>
      <span className="sr-only">{tile.lowerBound === true ? t('lists.atLeast', { value: text }) : text}</span>
    </span>
  );
}

function Body({ tile }: { tile: SummaryTile }): ReactNode {
  return (
    <>
      <Figure tile={tile} />
      <span className="summary-tile__label">
        <span className="summary-tile__dot" aria-hidden="true" />
        <span>{tile.label}</span>
      </span>
    </>
  );
}

function Tile({ tile }: { tile: SummaryTile }) {
  const className = `summary-tile summary-tile--${tile.tone}`;
  if (tile.href !== undefined) {
    return (
      <Link to={tile.href} className={className} title={tile.tip}>
        <Body tile={tile} />
      </Link>
    );
  }
  if (tile.onToggle !== undefined) {
    return (
      <button
        type="button"
        className={className}
        title={tile.tip}
        aria-pressed={tile.pressed === true}
        onClick={tile.onToggle}
      >
        <Body tile={tile} />
      </button>
    );
  }
  return (
    <div className={className} title={tile.tip}>
      <Body tile={tile} />
    </div>
  );
}

/**
 * A row of big figures with a dot and a word each (ADR 0071 decision 1: large numbers for what matters). A tile is a link, a toggle
 * button or plain text. The figures go through `useFormat`; a null value is a dash with "not available", a lower bound is `N+`.
 */
export function SummaryStrip({ tiles, label }: SummaryStripProps) {
  return (
    <ul className="summary-strip" aria-label={label}>
      {tiles.map((tile) => (
        <li key={tile.id} className="summary-strip__item">
          <Tile tile={tile} />
        </li>
      ))}
    </ul>
  );
}
