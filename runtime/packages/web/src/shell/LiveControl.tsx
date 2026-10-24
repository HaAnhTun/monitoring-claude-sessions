import { Popover } from '../components/Popover.tsx';
import { useT } from '../i18n/context.ts';
import type { Freshness } from '../stream/freshness.ts';
import { HealthPopover, LiveDot } from './HealthPopover.tsx';

/**
 * The one status control of the top bar (ADR 0073 decision 5, ADR 0033): a dot and a word whose colour is the worse of the
 * connection and the ingestion. The signals stay separate in the popover it opens (Connection, Ingestion, Server, Errors). The word
 * always says what is wrong ("Reconnecting", "Ingestion degraded"); colour is the second cue. `data-live-state` is the tone.
 */
export function LiveControl({ freshness }: { freshness: Freshness }) {
  const t = useT();
  const { live, connection, ingestion } = freshness;
  return (
    <div
      className="live-control"
      data-live-state={live.tone}
      data-live-source={live.source}
      data-connection={connection.state}
      data-ingestion={ingestion.display}
    >
      <Popover
        variant="quiet"
        align="end"
        panelLabel={t('live.popover.label')}
        label={
          <>
            <LiveDot tone={live.tone} />
            <span className="live-control__word">{t(live.textKey)}</span>
          </>
        }
      >
        {({ close }) => <HealthPopover freshness={freshness} onNavigate={close} />}
      </Popover>
    </div>
  );
}
