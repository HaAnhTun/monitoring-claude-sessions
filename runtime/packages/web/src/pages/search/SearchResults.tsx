import type { InstanceSearchResponse, SearchCoverage } from '@mcs/shared';
import { useId } from 'react';
import { Link } from 'react-router';

import { Disclosure } from '../../components/Disclosure.tsx';
import { EmptyState } from '../../components/EmptyState.tsx';
import { Icon } from '../../components/Icon.tsx';
import { useFormat, useT } from '../../i18n/context.ts';
import { ServerText } from '../../i18n/ServerText.tsx';
import type { MessageKey } from '../../i18n/types.ts';
import { SearchHit, type SearchMatch } from './SearchHit.tsx';

const SHORT_ID_CHARS = 8;

export interface SessionGroup {
  sessionId: string;
  label: string;
  hits: SearchMatch[];
}

/** The matches grouped by session, in the order the server sent them (most recent session first). */
export function groupBySession(matches: readonly SearchMatch[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const match of matches) {
    const existing = groups.get(match.sessionId);
    if (existing === undefined) {
      const label = match.sessionLabel === '' ? match.sessionId.slice(0, SHORT_ID_CHARS) : match.sessionLabel;
      groups.set(match.sessionId, { sessionId: match.sessionId, label, hits: [match] });
    } else {
      existing.hits.push(match);
    }
  }
  return [...groups.values()];
}

const STOPPED_KEYS = {
  complete: 'transcript.search.stopped.complete',
  match_limit: 'transcript.search.stopped.match_limit',
  time_budget: 'transcript.search.stopped.time_budget',
  cancelled: 'transcript.search.stopped.cancelled',
} as const satisfies Record<SearchCoverage['stoppedBy'], MessageKey>;

/** Why part of the transcripts was not searched, from the counts of the coverage (only the reasons that apply). */
function Reasons({ coverage }: { coverage: SearchCoverage }) {
  const t = useT();
  const format = useFormat();
  return (
    <ul className="search-coverage__reasons">
      {coverage.filesMissing > 0 ? <li>{t('search.coverage.missing', { count: coverage.filesMissing })}</li> : null}
      {coverage.filesUnreadable > 0 ? (
        <li>{t('search.coverage.unreadable', { count: coverage.filesUnreadable })}</li>
      ) : null}
      {coverage.bytesNotIndexed > 0 ? (
        <li>{t('search.coverage.notIndexed', { size: format.bytes(coverage.bytesNotIndexed) })}</li>
      ) : null}
      {coverage.stoppedBy === 'time_budget' ? <li>{t('search.coverage.timeBudget')}</li> : null}
    </ul>
  );
}

/**
 * What the search covered, in the server's own numbers: files searched of files in scope, a warning with the reasons when part
 * was not searched, the server's note as it came, and the byte and time figures behind a disclosure.
 */
export function SearchCoverageView({ coverage }: { coverage: SearchCoverage }) {
  const t = useT();
  const format = useFormat();
  const detailsId = useId();
  return (
    <section className="search-coverage" aria-label={t('search.coverage.title')}>
      <p className="search-coverage__files">
        {t('search.coverage.files', { scanned: coverage.filesScanned, total: coverage.filesInScope })}
      </p>
      {coverage.complete ? null : (
        <div className="search-coverage__warn" role="note">
          <Icon name="alert" />
          <div>
            <p className="search-coverage__incomplete">{t('search.coverage.incomplete')}</p>
            <Reasons coverage={coverage} />
          </div>
        </div>
      )}
      <ServerText as="p" className="small muted">
        {coverage.note}
      </ServerText>
      <Disclosure id={detailsId} label={t('transcript.search.coverage')}>
        <ul className="small muted search-coverage__details">
          <li>
            {t('transcript.search.bytes', {
              scanned: format.bytes(coverage.bytesScanned),
              total: format.bytes(coverage.bytesInScope),
            })}
          </li>
          <li>{t('transcript.search.entries', { count: coverage.entriesScanned })}</li>
          <li>
            {t('transcript.search.stoppedBy', {
              reason: t(STOPPED_KEYS[coverage.stoppedBy]),
              ms: coverage.elapsedMs,
            })}
          </li>
        </ul>
      </Disclosure>
    </section>
  );
}

function Group({ group, q }: { group: SessionGroup; q: string }) {
  const t = useT();
  const headingId = useId();
  return (
    <section className="search-group" aria-labelledby={headingId}>
      <h2 className="search-group__head" id={headingId}>
        <Link
          className="search-group__session"
          to={`/sessions/${encodeURIComponent(group.sessionId)}`}
          title={group.label}
        >
          {group.label}
        </Link>
        <span className="search-group__count muted">{t('search.group.count', { count: group.hits.length })}</span>
      </h2>
      <ul className="search-hits">
        {group.hits.map((hit, n) => (
          <SearchHit key={`${hit.agentId}-${String(hit.i)}-${String(n)}`} match={hit} q={q} />
        ))}
      </ul>
    </section>
  );
}

export interface SearchResultsProps {
  response: InstanceSearchResponse;
}

/**
 * The answer to a search: the matches grouped by session, a note when the list was cut, and always the coverage. An empty answer
 * says so in the words of what was searched: "no matches" only claims the whole instance when the search covered all of it.
 */
export function SearchResults({ response }: SearchResultsProps) {
  const t = useT();
  const { matches, coverage } = response;
  const groups = groupBySession(matches);
  return (
    <div className="search-results">
      {matches.length === 0 ? (
        <EmptyState icon="search" title={t(coverage.complete ? 'search.empty.title' : 'search.empty.incompleteTitle')}>
          {t('search.empty.hint')}
        </EmptyState>
      ) : (
        <>
          <p className="search-summary" role="status">
            {t('search.summary', { count: matches.length, sessions: groups.length })}
          </p>
          <div className="search-groups" role="region" aria-label={t('search.results.label')}>
            {groups.map((group) => (
              <Group key={group.sessionId} group={group} q={response.query.q} />
            ))}
          </div>
          {response.truncated ? <p className="small">{t('search.truncated', { count: matches.length })}</p> : null}
        </>
      )}
      <SearchCoverageView coverage={coverage} />
    </div>
  );
}
