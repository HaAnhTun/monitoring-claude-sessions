import { Link } from 'react-router';

import { Icon } from '../components/Icon.tsx';
import type { IngestionView } from '../lib/connection-health.ts';
import type { ChipView } from '../stream/freshness.ts';

export interface IngestionChipProps {
  view: IngestionView;
  /** The words, tone and icon of the table in 04 5.6 (`Freshness.ingestionChip`). */
  chip: ChipView;
}

/**
 * What the server says about its own ingestion (`/health`), never inferred from the stream (UI-I4). While the client is not in
 * sync the model already turned it into "unknown" with the last known status, so this chip cannot claim "OK" by itself.
 * The first reason is visible on wide screens, every reason is in the `title`; the chip opens the health section of the settings.
 */
export function IngestionChip({ view, chip }: IngestionChipProps) {
  return (
    <Link
      to="/settings?section=health"
      className={`chip tone-${chip.tone}`}
      data-chip="ingestion"
      data-status={view.display}
      title={chip.title}
    >
      <Icon name={chip.icon} />
      <span>{chip.text}</span>
      {chip.detail === null ? null : <span className="chip__detail">{chip.detail}</span>}
    </Link>
  );
}
