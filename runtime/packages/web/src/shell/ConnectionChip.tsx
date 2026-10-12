import { Icon } from '../components/Icon.tsx';
import type { ConnectionView } from '../lib/connection-health.ts';
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
