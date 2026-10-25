import type { InstanceSearchResponse } from '@mcs/shared';
import { Fragment, memo } from 'react';
import { Link } from 'react-router';

import { RelativeTime } from '../../components/RelativeTime.tsx';
import { useT } from '../../i18n/context.ts';
import { highlight } from '../../transcript/TranscriptSearchResults.tsx';
import { ROW_LABEL_KEYS } from '../../transcript/TranscriptRow.tsx';

export type SearchMatch = InstanceSearchResponse['matches'][number];

export interface SearchHitProps {
  match: SearchMatch;
  /** The text that was searched; the matches in the snippet are marked. */
  q: string;
}

/** The transcript of the session, at the matching entry (of the subagent when the match is in one). */
export function hitHref(match: SearchMatch): string {
  const params = new URLSearchParams({ tab: 'transcript' });
  if (match.agentId !== 'main') params.set('agent', match.agentId);
  params.set('i', String(match.i));
  return `/sessions/${encodeURIComponent(match.sessionId)}?${params.toString()}`;
}

/**
 * One match: what kind of entry it is, who wrote it, when, and the snippet with the searched text marked. The whole row is the
 * link. The snippet is transcript text: it is drawn as text segments around `<mark>`, never as markup.
 */
export const SearchHit = memo(function SearchHit({ match, q }: SearchHitProps) {
  const t = useT();
  return (
    <li className="search-hit">
      <Link className="search-hit__link" to={hitHref(match)}>
        <span className="search-hit__meta">
          <span className="search-hit__kind">
            {t(ROW_LABEL_KEYS[match.k])}
            {match.name === null ? '' : ` ${match.name}`}
          </span>
          <span className="search-hit__agent muted" title={match.agentId}>
            {match.agentId === 'main' ? t('search.hit.agentMain') : t('search.hit.agentSub', { id: match.agentId })}
          </span>
          <span className="search-hit__entry muted mono">{t('search.hit.entry', { index: String(match.i) })}</span>
          <span className="search-hit__time muted">
            <RelativeTime iso={match.t} />
          </span>
        </span>
        <span className="search-hit__snippet">
          {highlight(match.snippet, q).map((part, n) => (
            <Fragment key={n}>{part}</Fragment>
          ))}
        </span>
      </Link>
    </li>
  );
});
