// `errors` (03 6.1, 6.3, 12.1): the recent errors of the instance, newest first. The query reads `ingest_errors` (spool,
// transcript, external, writer, handler, alerts and db errors; references and numbers only, never a body); the in-memory
// server ring (source `server`, code `INTERNAL`, 01 4.4a) belongs to the running process, which the query layer does not
// have: the server route adds it with `mergeServerErrors`. Offline (the CLI DbReader) only the stored rows exist (6.3).
import type { ErrorItem, ErrorsQuery, ErrorsResponse } from '@mcs/shared';

import type { InstanceDb, RepoContext } from '../db/open.ts';
import { Binder, iso, snapshot } from './transitions.ts';

export interface ErrorQueries {
  errors(ctx: RepoContext, q: ErrorsQuery): ErrorsResponse;
}

interface ErrorDbRow {
  id: number;
  at: number;
  source: string;
  code: string;
  segment: string | null;
  sessionUid: string | null;
  detail: string | null;
}

/** A stored row as the API item: the detail is the message (the code when there is none), the segment is the place. */
function itemOf(row: ErrorDbRow): ErrorItem {
  return {
    at: iso(row.at),
    source: row.source,
    code: row.code,
    where: row.segment,
    message: row.detail ?? row.code,
    sessionId: row.sessionUid,
  };
}

export function createErrorQueries(db: InstanceDb): ErrorQueries {
  return {
    errors: (ctx, q) =>
      snapshot(db, ctx, (asOfSeq): ErrorsResponse => {
        const bind = new Binder();
        const where: string[] = [];
        if (q.since !== undefined) where.push(`at >= ${bind.bind(Date.parse(q.since))}`);
        // the stored sources never include `server`: a filter of `server` alone matches no stored row
        if (q.source !== undefined) where.push(`source IN ${bind.list(q.source)}`);
        const rows = db.driver
          .prepare<ErrorDbRow>(
            `SELECT id, at, source, code, segment, session_uid AS sessionUid, detail FROM ingest_errors
              ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
              ORDER BY at DESC, id DESC LIMIT ${bind.bind(q.limit)}`,
          )
          .all(bind.params);
        return { asOfSeq, items: rows.map(itemOf) };
      }),
  };
}

/**
 * The answer of a running server: the entries of its error ring and the stored rows, newest first, with the filters of the
 * query applied to both. On equal times the server entry comes first. Pure: neither input is changed.
 */
export function mergeServerErrors(
  ring: readonly ErrorItem[],
  stored: readonly ErrorItem[],
  q: Pick<ErrorsQuery, 'since' | 'source' | 'limit'>,
): ErrorItem[] {
  const sinceMs = q.since === undefined ? null : Date.parse(q.since);
  const sources: readonly string[] | undefined = q.source;
  const wanted = (item: ErrorItem): boolean =>
    (sinceMs === null || Date.parse(item.at) >= sinceMs) && (sources === undefined || sources.includes(item.source));
  const tagged = [
    ...ring.filter(wanted).map((item, order) => ({ item, rank: 0, order })),
    ...stored.filter(wanted).map((item, order) => ({ item, rank: 1, order })),
  ];
  tagged.sort((a, b) => Date.parse(b.item.at) - Date.parse(a.item.at) || a.rank - b.rank || a.order - b.order);
  return tagged.slice(0, q.limit).map((entry) => ({ ...entry.item }));
}
