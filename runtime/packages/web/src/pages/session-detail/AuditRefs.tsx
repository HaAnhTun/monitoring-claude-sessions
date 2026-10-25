import type { SessionDetail } from '@mcs/shared';
import { useId } from 'react';

import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';
import { useT } from '../../i18n/context.ts';
import type { MessageKey } from '../../i18n/types.ts';

export interface AuditRefsProps {
  refs: SessionDetail['auditRefs'];
}

const FILE_KEYS = {
  changes: 'detail.auditRefs.changes',
  decisions: 'detail.auditRefs.decisions',
} as const satisfies Readonly<Record<SessionDetail['auditRefs'][number]['file'], MessageKey>>;

/**
 * The audit entries (changes and decisions) written while the session was running, newest first as the server sends them.
 * Titles and summaries are text, never markup. Nothing is rendered without entries.
 */
export function AuditRefs({ refs }: AuditRefsProps) {
  const t = useT();
  const titleId = useId();
  if (refs.length === 0) return null;
  return (
    <section className="audit-refs" aria-labelledby={titleId}>
      <h2 id={titleId} className="audit-refs__title">
        {t('detail.auditRefs.title')}
      </h2>
      <ul className="audit-refs__list">
        {refs.map((ref) => (
          <li key={`${ref.file}|${ref.at}|${ref.title}`} className="audit-refs__item">
            <span className="audit-refs__head">
              <TagBadge tone="neutral">{t(FILE_KEYS[ref.file])}</TagBadge> <RelativeTime iso={ref.at} mode="clock" />{' '}
              <strong>{ref.title}</strong>
            </span>
            {ref.summary === '' ? null : <span className="audit-refs__summary muted">{ref.summary}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
