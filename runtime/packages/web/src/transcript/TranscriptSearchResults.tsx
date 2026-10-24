import type { TranscriptSearchResponse } from '@mcs/shared';
import { Fragment, useId, type ReactNode } from 'react';

import { Button } from '../components/Button.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { describeApiError, type ApiError } from '../data/api-errors.ts';
import { useFormat, useT } from '../i18n/context.ts';
import { ServerText } from '../i18n/ServerText.tsx';
import type { MessageKey } from '../i18n/types.ts';
import { ROW_LABEL_KEYS } from './TranscriptRow.tsx';

export interface TranscriptSearchResultsProps {
  status: 'loading' | 'error' | 'ready';
  response: TranscriptSearchResponse | null;
  error: ApiError | null;
  /** Jump to the entry with this index. */
  onJump: (index: number) => void;
  onClose: () => void;
}

const STOPPED_KEYS = {
  complete: 'transcript.search.stopped.complete',
  match_limit: 'transcript.search.stopped.match_limit',
  time_budget: 'transcript.search.stopped.time_budget',
  cancelled: 'transcript.search.stopped.cancelled',
} as const satisfies Record<TranscriptSearchResponse['coverage']['stoppedBy'], MessageKey>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The snippet as text segments with the matches wrapped in `<mark>`: no HTML string is ever built (04-ui.md section 8). */
export function highlight(snippet: string, q: string): ReactNode[] {
  if (q === '') return [snippet];
  const parts: ReactNode[] = [];
  const re = new RegExp(escapeRegExp(q), 'gi');
  let last = 0;
  for (let m = re.exec(snippet); m !== null; m = re.exec(snippet)) {
    if (m.index > last) parts.push(snippet.slice(last, m.index));
    parts.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < snippet.length) parts.push(snippet.slice(last));
  return parts;
}

function Body({ response, onJump }: { response: TranscriptSearchResponse; onJump: (index: number) => void }) {
  const t = useT();
  const format = useFormat();
  const coverageId = useId();
  const { coverage, matches } = response;
  return (
    <>
      {matches.length === 0 ? (
        <p className="tv-search__empty">{t('transcript.search.empty')}</p>
      ) : (
        <ul className="tv-hits">
          {matches.map((match) => (
            <li key={`${String(match.i)}-${String(match.offset)}`}>
              <button
                type="button"
                className="tv-hit"
                aria-label={t('transcript.search.jumpTo', { index: String(match.i) })}
                onClick={() => {
                  onJump(match.i);
                }}
              >
                <span className="tv-hit__index mono">{`#${String(match.i)}`}</span>
                <span className="tv-hit__time muted">{format.clock(match.t)}</span>
                <span className="tv-hit__kind">
                  {t(ROW_LABEL_KEYS[match.k])}
                  {match.name === null ? '' : ` ${match.name}`}
                </span>
                <span className="tv-hit__snippet">
                  {highlight(match.snippet, response.query.q).map((part, n) => (
                    <Fragment key={n}>{part}</Fragment>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {response.truncated ? (
        <p className="small">{t('transcript.search.truncated', { count: matches.length })}</p>
      ) : null}
      <ServerText as="p" className="small muted">
        {coverage.note}
      </ServerText>
      {response.complete ? null : <p className="small tv-search__warn">{t('transcript.search.incomplete')}</p>}
      <Disclosure id={coverageId} label={t('transcript.search.coverage')}>
        <ul className="small muted">
          <li>{t('transcript.search.files', { scanned: coverage.filesScanned, total: coverage.filesInScope })}</li>
          <li>
            {t('transcript.search.bytes', {
              scanned: format.bytes(coverage.bytesScanned),
              total: format.bytes(coverage.bytesInScope),
            })}
          </li>
          <li>{t('transcript.search.notIndexed', { size: format.bytes(coverage.bytesNotIndexed) })}</li>
          <li>{t('transcript.search.entries', { count: coverage.entriesScanned })}</li>
          <li>
            {t('transcript.search.stoppedBy', {
              reason: t(STOPPED_KEYS[coverage.stoppedBy]),
              ms: coverage.elapsedMs,
            })}
          </li>
        </ul>
      </Disclosure>
    </>
  );
}

/** The results of a whole-transcript search (04-ui.md 4.4.3 step 9): honest about what was and was not searched. */
export function TranscriptSearchResults({ status, response, error, onJump, onClose }: TranscriptSearchResultsProps) {
  const t = useT();
  const detail = describeApiError(error ?? undefined, t);
  return (
    <div className="tv-search" role="region" aria-label={t('transcript.search.region')}>
      <div className="tv-search__head">
        <h3 className="tv-search__title">{t('transcript.search.title')}</h3>
        <Button variant="quiet" icon="x" aria-label={t('transcript.search.close')} onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
      {status === 'loading' ? (
        <p role="status" aria-busy="true">
          {t('transcript.search.loading')}
        </p>
      ) : null}
      {status === 'error' ? (
        <p role="status">
          {error?.info.code === 'search_busy'
            ? t('transcript.search.busy')
            : detail === undefined
              ? t('transcript.search.failedPlain')
              : t('transcript.search.failed', { detail })}
        </p>
      ) : null}
      {status === 'ready' && response !== null ? <Body response={response} onJump={onJump} /> : null}
    </div>
  );
}
