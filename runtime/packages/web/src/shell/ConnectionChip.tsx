import { Icon } from '../components/Icon.tsx';
import type { ConnectionView } from '../lib/connection-health.ts';
// eslint-disable-next-line no-restricted-imports -- the Node builtin pattern `stream` also matches the web folder src/stream (CR-WP-48-1)
import type { ChipView } from '../stream/freshness.ts';

export interface ConnectionChipProps {
  view: ConnectionView;
  /** The words, tone and icon of the table in 04 5.6 (`Freshness.connectionChip`). */
  chip: ChipView;
}

/**
 * What the client observes about its link to the monitor: live, paused, reconnecting, lost (04 5.6, ADR 0033). It says nothing
 * about ingestion; that is the other chip. The tone colours the chip, the icon and the words carry the meaning (UI-I8).
 */
export function ConnectionChip({ view, chip }: ConnectionChipProps) {
  return (
    <span className={`chip tone-${chip.tone}`} data-chip="connection" data-status={view.state} title={chip.title}>
      <Icon name={chip.icon} />
      <span>{chip.text}</span>
    </span>
  );
}
