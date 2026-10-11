// The ingest error codes (02 4.8, registry 7.5) and the record a producer hands to the writer for one of them.
//
// These are `ingest_errors.code` values (upper case, 03 `ingest_errors` CHECK). They are distinct from the lowercase HTTP
// `ErrorCode` union (03 5.2) and from the CLI codes (`CliErrorCode`). A record carries references and numbers only: never a
// line, a prompt, a path outside the instance or a token (rule 7 of AGENTS: nothing private in logs or tables).
import { clipCodePoints } from '../platform/fsx.ts';

export const INGEST_ERROR_CODES = [
  'SPOOL_LINE_INVALID_JSON',
  'ENVELOPE_SCHEMA',
  'ENVELOPE_VERSION',
  'INSTANCE_MISMATCH',
  'SPOOL_TORN_TAIL',
  'INVALID_SESSION_ID',
  'RECORD_INVALID_JSON',
  'RECORD_NOT_OBJECT',
  'RECORD_SHAPE',
  'LINE_TOO_LONG',
  'UTF8_INVALID',
  'READ_FAILED',
  'SYMLINK_SKIPPED',
  'PATH_OUTSIDE_ROOT',
  'IDENTITY_RESET',
  'PERSIST_FAILED',
  'EXTERNAL_READ_FAILED',
  // replay only (02 2.7); the CLI maps it to NOT_FOUND
  'SPOOL_SEGMENT_NOT_FOUND',
] as const;

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

/** Where the error was seen (`ingest_errors.source`; the other two values of the column belong to alerts and the DB layer). */
export type IngestErrorOrigin = 'spool' | 'transcript' | 'external' | 'writer' | 'handler';

const KNOWN: ReadonlySet<string> = new Set(INGEST_ERROR_CODES);

export function isIngestErrorCode(value: unknown): value is IngestErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}

/** The cap of `ingest_errors.detail`, in code points (03 3.5). */
export const INGEST_ERROR_DETAIL_MAX_CP = 200;

/** One occurrence as a producer reports it; the writer stamps `at` with the clock of the transaction. */
export interface IngestErrorRecord {
  readonly code: IngestErrorCode;
  readonly source: IngestErrorOrigin;
  readonly segment?: string | null;
  readonly fileId?: number | null;
  readonly byteOffset?: number | null;
  readonly sessionUid?: string | null;
  /** Names and numbers only, at most 200 code points. */
  readonly detail?: string | null;
}

/** Builds a record and cuts the detail to the column cap. */
export function ingestError(
  code: IngestErrorCode,
  source: IngestErrorOrigin,
  fields: Omit<IngestErrorRecord, 'code' | 'source' | 'detail'> & { detail?: string | null } = {},
): IngestErrorRecord {
  const { detail, ...rest } = fields;
  return {
    code,
    source,
    ...rest,
    ...(detail === undefined || detail === null ? {} : { detail: clipCodePoints(detail, INGEST_ERROR_DETAIL_MAX_CP) }),
  };
}

/** Replay named a segment that is not a segment name or not on disk (02 2.7 step 1). */
export class SpoolSegmentNotFoundError extends Error {
  readonly code = 'SPOOL_SEGMENT_NOT_FOUND' as const;
  readonly segment: string;

  constructor(segment: string) {
    super(`spool segment not found: ${clipCodePoints(segment, 80)}`);
    this.name = 'SpoolSegmentNotFoundError';
    this.segment = clipCodePoints(segment, 80);
  }
}

/** The writer is closed or paused: a producer that submits anyway learns it here. */
export class IngestWriterClosedError extends Error {
  readonly code = 'WRITER_CLOSED' as const;

  constructor() {
    super('the ingest writer is closed');
    this.name = 'IngestWriterClosedError';
  }
}
