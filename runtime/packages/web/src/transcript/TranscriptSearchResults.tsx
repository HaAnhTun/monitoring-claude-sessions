import type { TranscriptSearchResponse } from '@mcs/shared';
import { Fragment, useId, type ReactNode } from 'react';

import type { ApiError } from '../data/api-errors.ts';
import { Button } from '../components/Button.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { fmtClock, fmtMB } from '../lib/format.ts';
import { ROW_LABELS } from './TranscriptRow.tsx';

export interface TranscriptSearchResultsProps {
  status: 'loading' | 'error' | 'ready';
  response: TranscriptSearchResponse | null;
  error: ApiError | null;
  /** Jump to the entry with this index. */
  onJump: (index: number) => void;
  onClose: () => void;
}

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
  const coverageId = useId();
  const { coverage, matches } = response;
  return (
    <>
      {matches.length === 0 ? (
        <p className="tv-search__empty">No matches in the searched part of the transcript.</p>
      ) : (
        <ul className="tv-hits">
          {matches.map((match) => (
            <li key={`${String(match.i)}-${String(match.offset)}`}>
              <button
                type="button"
                className="tv-hit"
                aria-label={`Jump to #${String(match.i)}`}
                onClick={() => {
                  onJump(match.i);
                }}
              >
                <span className="tv-hit__index mono">{`#${String(match.i)}`}</span>
                <span className="tv-hit__time muted">{fmtClock(match.t)}</span>
                <span className="tv-hit__kind">
                  {ROW_LABELS[match.k]}
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
      {response.truncated ? <p className="small">{`Showing the first ${String(matches.length)} matches`}</p> : null}
      <p className="small muted">{coverage.note}</p>
      {response.complete ? null : (
        <p className="small tv-search__warn">Not every part of the transcript was searched</p>
      )}
      <Disclosure id={coverageId} label="Coverage details">
        <ul className="small muted">
          <li>{`Files scanned: ${String(coverage.filesScanned)} of ${String(coverage.filesInScope)}`}</li>
          <li>{`Scanned: ${fmtMB(coverage.bytesScanned)} of ${fmtMB(coverage.bytesInScope)}`}</li>
          <li>{`Not indexed yet: ${fmtMB(coverage.bytesNotIndexed)}`}</li>
          <li>{`Entries scanned: ${String(coverage.entriesScanned)}`}</li>
          <li>{`Stopped by: ${coverage.stoppedBy} after ${String(coverage.elapsedMs)} ms`}</li>
        </ul>
      </Disclosure>
    </>
  );
}

/** The results of a whole-transcript search (04-ui.md 4.4.3 step 9): honest about what was and was not searched. */
export function TranscriptSearchResults({ status, response, error, onJump, onClose }: TranscriptSearchResultsProps) {
  return (
    <div className="tv-search" role="region" aria-label="Transcript search results">
      <div className="tv-search__head">
        <h3 className="tv-search__title">Search results</h3>
        <Button variant="quiet" icon="x" aria-label="Close search results" onClick={onClose}>
          Close
        </Button>
      </div>
      {status === 'loading' ? (
        <p role="status" aria-busy="true">
          Searching the transcript...
        </p>
      ) : null}
      {status === 'error' ? (
        <p role="status">
          {error?.info.code === 'search_busy'
            ? 'Another search is running; try again in a moment'
            : `Search failed: ${error?.message ?? 'unknown error'}`}
        </p>
      ) : null}
      {status === 'ready' && response !== null ? <Body response={response} onJump={onJump} /> : null}
    </div>
  );
}
