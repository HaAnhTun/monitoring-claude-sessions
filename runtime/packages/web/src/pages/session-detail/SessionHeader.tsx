import type { AgentNode, SessionDetail } from '@mcs/shared';
import type { ReactNode, Ref } from 'react';
import { Link, useLocation } from 'react-router';

import { CopyButton } from '../../components/CopyButton.tsx';
import { EvidenceLine } from '../../components/EvidenceLine.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Popover } from '../../components/Popover.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import { stateEvidence } from '../../lib/state-evidence.ts';

export interface SessionHeaderProps {
  session: SessionDetail;
  /** The chosen subagent; `null` is the main agent. */
  agent: AgentNode | null;
  /** The page heading is focused after a navigation (04 3.1 rule 5). */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Shown under the title row (banners). */
  children?: ReactNode;
}

/** What the monitor saw that led to the state: how it knows, and the evidence items with their times. */
function EvidencePanel({ session }: { session: SessionDetail }) {
  const t = useT();
  const { state } = session;
  const words = stateEvidence(state, session.lastActivityAt, 0);
  return (
    <div className="session-evidence">
      <p className="session-evidence__basis">
        {t('evidence.basisTip', { basis: t(words.basisKey), confidence: t(words.confidenceKey) })}
      </p>
      {state.evidence.length === 0 ? (
        <p className="muted">{t('detail.evidence.none')}</p>
      ) : (
        <ul className="session-evidence__list">
          {state.evidence.map((item, index) => (
            <li key={`${item.kind}|${String(index)}`}>
              <ServerText>{item.text}</ServerText> <RelativeTime iso={item.at} mode="clock" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The top of the session page (ADR 0073 decision 8): a way back to the list, the title, the state as a dot and a word with the
 * one-line evidence behind it, and the link of the view. The whole id and the other fields are in `SessionDetails`. Every value is
 * text; nothing from a transcript or an audit file is interpreted as markup.
 */
export function SessionHeader({ session, agent, headingRef, children }: SessionHeaderProps) {
  const t = useT();
  const { pathname, search } = useLocation();
  const title = agent === null || agent.kind === 'main' ? session.label : `${session.label} / ${agent.label}`;
  const { state } = session;
  return (
    <header className="session-header">
      <div className="session-header__title">
        <Link className="session-header__back" to="/sessions" title={t('detail.back.tip')}>
          <Icon name="chevron-left" />
          {t('detail.back')}
        </Link>
        <h1 ref={headingRef} tabIndex={-1} title={title}>
          {title}
        </h1>
      </div>
      <div className="session-header__state">
        <StateBadge state={state.state} assessment={state} lastActivityAt={session.lastActivityAt} />
        <EvidenceLine assessment={state} lastActivityAt={session.lastActivityAt} />
        {session.matched ? null : (
          <TagBadge tone="neutral" tip={t('detail.notInList.tip')}>
            {t('detail.notInList')}
          </TagBadge>
        )}
        <Popover
          variant="quiet"
          icon="chevron-down"
          label={t('detail.evidence')}
          panelLabel={t('detail.evidence.panel')}
        >
          <EvidencePanel session={session} />
        </Popover>
      </div>
      <CopyButton label={t('detail.copyLink')} text={() => `${window.location.origin}${pathname}${search}`}>
        <Icon name="link" />
        <span className="session-header__copy-text">{t('detail.copyLink')}</span>
      </CopyButton>
      {children}
    </header>
  );
}
