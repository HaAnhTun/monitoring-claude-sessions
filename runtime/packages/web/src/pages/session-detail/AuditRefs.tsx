import type { SessionDetail } from '@mcs/shared';

import { RelativeTime } from '../../components/RelativeTime.tsx';
import { TagBadge } from '../../components/TagBadge.tsx';

export interface AuditRefsProps {
  refs: SessionDetail['auditRefs'];
}

/**
 * The audit entries (changes and decisions) written while the session was running, newest first as the server sends them.
 * Titles and summaries are text, never markup. Nothing is rendered without entries.
 */
export function AuditRefs({ refs }: AuditRefsProps) {
  if (refs.length === 0) return null;
  return (
    <section className="audit-refs" aria-label="Audit references">
      <h2 className="audit-refs__title">Audit references</h2>
      <ul className="audit-refs__list">
        {refs.map((ref) => (
          <li key={`${ref.file}|${ref.at}|${ref.title}`} className="audit-refs__item">
            <span className="audit-refs__head">
              <TagBadge tone="neutral">{ref.file}</TagBadge> <RelativeTime iso={ref.at} mode="clock" />{' '}
              <strong>{ref.title}</strong>
            </span>
            {ref.summary === '' ? null : <span className="audit-refs__summary muted">{ref.summary}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
