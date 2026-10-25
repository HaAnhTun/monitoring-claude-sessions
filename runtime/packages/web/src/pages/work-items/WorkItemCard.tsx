import type { WorkItem } from '@mcs/shared';
import { useId } from 'react';
import { Link } from 'react-router';

import { Disclosure } from '../../components/Disclosure.tsx';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { TokenFigures } from '../../components/TokenFigures.tsx';
import { useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';
import { boardDisplay } from '../../lib/lifecycle-display.ts';

/** Session links shown on a card; the rest is one "+N" link to the sessions list of the task (04 4.4.5). */
export const MAX_SESSION_LINKS = 5;
const SHORT_ID_CHARS = 8;

const SOURCE_LABEL = {
  declared: 'tasks.source.declared',
  attempts: 'tasks.source.attempts',
  label: 'tasks.source.label',
} as const satisfies Readonly<Record<WorkItem['source'], MessageKey>>;

const RULE_TIP = {
  'W-DECL': 'tasks.rule.declared',
  'W-ATT': 'tasks.rule.attempts',
  'W-LBL': 'tasks.rule.label',
} as const satisfies Readonly<Record<WorkItem['rule'], MessageKey>>;

export interface WorkItemCardProps {
  item: WorkItem;
}

/**
 * One work item (04 4.4.5): title, where it comes from (source and rule), its state, why the board put it there (server text, with
 * the evidence behind it), the sessions that belong to it, since when, the last activity and the token figures. Read-only.
 */
export function WorkItemCard({ item }: WorkItemCardProps) {
  const t = useT();
  const titleId = useId();
  const evidenceId = useId();
  const display = boardDisplay(item.state);
  const shown = item.sessionIds.slice(0, MAX_SESSION_LINKS);
  const more = Math.max(0, item.sessionCount - shown.length);

  return (
    <article className="card work-card" aria-labelledby={titleId} data-state={item.state}>
      <header className="work-card__head">
        <h3 id={titleId} className="work-card__title">
          {item.title}
        </h3>
        <div className="work-card__tags">
          <span className={`badge badge--state badge--sm ${display.toneClass}`}>
            <span className="state-dot state-dot--solid" aria-hidden="true" />
            <span className="badge__word">{t(display.labelKey)}</span>
          </span>
          <TagBadge tone="neutral" tip={t(RULE_TIP[item.rule])}>
            {t(SOURCE_LABEL[item.source])} <span className="work-card__rule mono">{item.rule}</span>
          </TagBadge>
        </div>
      </header>

      <p className="work-card__why">
        <span className="work-card__why-label">{t('tasks.card.why')}</span> <ServerText>{item.boardReason}</ServerText>
      </p>
      {item.evidence.length === 0 ? null : (
        <Disclosure id={evidenceId} label={t('tasks.card.evidence', { count: item.evidence.length })}>
          <ul className="work-card__evidence" aria-label={t('tasks.card.evidenceFor', { title: item.title })}>
            {item.evidence.map((entry, index) => (
              <li key={`${entry.kind}|${String(index)}`}>
                <span className="work-card__evidence-kind mono">{entry.kind}</span>
                {entry.at === null ? null : (
                  <span className="muted">
                    <RelativeTime iso={entry.at} />
                  </span>
                )}
                <ServerText>{entry.text}</ServerText>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}

      <div className="work-card__sessions">
        <span className="work-card__count">{t('tasks.card.sessions', { count: item.sessionCount })}</span>
        {shown.map((id) => (
          <Link
            key={id}
            to={`/sessions/${encodeURIComponent(id)}`}
            className="work-card__session mono"
            aria-label={t('tasks.card.openSession', { id: id.slice(0, SHORT_ID_CHARS) })}
          >
            {id.slice(0, SHORT_ID_CHARS)}
          </Link>
        ))}
        {more === 0 ? null : (
          <Link
            to={`/sessions?task=${String(item.id)}`}
            className="work-card__session work-card__session--more"
            aria-label={t('tasks.card.allSessions', { count: item.sessionCount })}
          >
            {`+${String(more)}`}
          </Link>
        )}
      </div>

      <dl className="work-card__meta">
        <div>
          <dt>{t('tasks.card.since')}</dt>
          <dd>
            <RelativeTime iso={item.since} />
          </dd>
        </div>
        <div>
          <dt>{t('tasks.card.lastActivity')}</dt>
          <dd>
            <RelativeTime iso={item.lastActivityAt} />
          </dd>
        </div>
      </dl>
      <TokenFigures usage={item.usage} variant="line" />
    </article>
  );
}
