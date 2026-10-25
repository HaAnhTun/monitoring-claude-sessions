import type { PanelDataMap, PanelKey, PanelSourceState } from '@mcs/shared';
import { useId, type ReactNode } from 'react';

import { Icon } from '../components/Icon.tsx';
import type { IconName } from '../components/icons.ts';
import { RelativeTime, useNow } from '../components/RelativeTime.tsx';
import { useFormat, useT } from '../i18n/context.ts';
import { ServerText } from '../i18n/ServerText.tsx';
import type { PanelViewStatus } from '../lib/panel-status.ts';

export interface PanelFrameProps {
  panelKey: PanelKey;
  title: string;
  icon: IconName;
  status: PanelViewStatus;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  /**
   * The reason of an `error` status already worded through the catalogue (a failed request). Without it the message of the
   * status is shown as server text, which is what a panel that answered `status: error` sends.
   */
  errorDetail?: string | undefined;
  /** The body of the panel; drawn inside the frame, hidden while it is collapsed. */
  children: ReactNode;
}

const MS_PER_SECOND = 1000;

/** The instant a status describes, in epoch milliseconds; `null` while nothing has been received. */
function instantOf(status: PanelViewStatus): number | null {
  switch (status.kind) {
    case 'ok':
    case 'partial':
    case 'stale':
      return status.asOf;
    case 'error':
      return status.lastGoodAt;
    case 'loading':
      return null;
  }
}

function withoutFinalStop(text: string): string {
  return text.replace(/[. ]+$/u, '');
}

interface StatusLineProps {
  status: PanelViewStatus;
  errorDetail: string | undefined;
  now: number;
}

function StatusLine({ status, errorDetail, now }: StatusLineProps) {
  const t = useT();
  const format = useFormat();
  const ageOf = (instant: number): string => format.age(Math.max(0, (now - instant) / MS_PER_SECOND));
  switch (status.kind) {
    case 'ok':
      return null;
    case 'loading':
      return <span className="muted">{t('common.loading')}</span>;
    case 'stale':
      return <span>{t('panels.status.stale', { age: ageOf(status.asOf) })}</span>;
    case 'partial':
      return (
        <>
          <span>{t('panels.status.partial')}</span>
          <ul className="panel-status__notes">
            {status.notes.map((note) => (
              <ServerText key={note} as="li">
                {note}
              </ServerText>
            ))}
          </ul>
        </>
      );
    case 'error':
      return (
        <>
          <span>{status.lastGoodAt === null ? t('panels.status.errorLead') : t('panels.status.refreshLead')}</span>{' '}
          {errorDetail === undefined ? (
            <ServerText>{`${withoutFinalStop(status.message)}.`}</ServerText>
          ) : (
            <span>{`${withoutFinalStop(errorDetail)}.`}</span>
          )}
          {status.lastGoodAt === null ? null : (
            <>
              {' '}
              <span>{t('panels.status.keptData', { age: ageOf(status.lastGoodAt) })}</span>
            </>
          )}
        </>
      );
  }
}

/**
 * The frame of a workspace panel (04-ui.md 4.4.1): a card with a heading that is the toggle (`h2 > button[aria-expanded]`), the age
 * of the data, a status line that says what is wrong with it (loading, stale, partial with a note per source, failed with or
 * without older data) and the body. The body is hidden, not removed, while the panel is collapsed, so the button always controls
 * an element; the caller decides what to fetch and draw.
 */
export function PanelFrame({
  panelKey,
  title,
  icon,
  status,
  expanded,
  onToggle,
  errorDetail,
  children,
}: PanelFrameProps) {
  const titleId = useId();
  const bodyId = useId();
  const instant = instantOf(status);
  const ticking = status.kind === 'stale' || (status.kind === 'error' && status.lastGoodAt !== null);
  const now = useNow(ticking);
  return (
    <section className="card panel" aria-labelledby={titleId} data-panel={panelKey} data-status={status.kind}>
      <header className="panel__head">
        <h2 id={titleId} className="panel__title">
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => {
              onToggle(!expanded);
            }}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            <Icon name={icon} className="panel__icon" />
            <span>{title}</span>
          </button>
        </h2>
        {instant === null ? null : (
          <span className="panel__asof muted">
            <RelativeTime iso={new Date(instant).toISOString()} />
          </span>
        )}
      </header>
      <div id={bodyId} className="panel__body" hidden={!expanded}>
        <div className="panel-status" role="status" data-kind={status.kind}>
          <StatusLine status={status} errorDetail={errorDetail} now={now} />
        </div>
        {children}
      </div>
    </section>
  );
}

/** What every panel body gets: the data of its panel and the state of the sources behind it. */
export interface PanelBodyProps<K extends PanelKey> {
  data: PanelDataMap[K];
  sources: readonly PanelSourceState[];
}

/** A quiet sentence in a panel body: nothing to show, or why a part cannot be shown. */
export function PanelNote({ children }: { children: ReactNode }) {
  return <p className="panel-note">{children}</p>;
}

/** A missing value: a dash for the eye, "Not available" for assistive technology. Never a zero. */
export function Dash() {
  const t = useT();
  return (
    <span className="muted" title={t('common.notAvailable')}>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{t('common.notAvailable')}</span>
    </span>
  );
}
