// Appends one envelope line to the hourly spool segment of a route (02 2.2 step 11, 2.7). One `writeSync` on an fd opened
// with flag `a` keeps lines whole under concurrent writers.
import { closeSync, fstatSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs';

import {
  ENVELOPE_MAX_BYTES,
  MINIMAL_CALLS_MAX,
  MINIMAL_DATA_KEYS,
  SPOOL_SEGMENT_HARD_CAP,
  SPOOL_SEGMENT_SOFT_CAP,
  spoolSegmentName,
  type EnvelopeDataValue,
  type HookEnvelopeV1,
  type HookRouteV1,
} from '@mcs/shared/protocol';

export type SpoolOutcome = 'written' | 'full' | 'failed';

export interface SpoolResult {
  outcome: SpoolOutcome;
  /** Short reason for the handler log (an error code); never payload text. */
  detail: string;
}

/** The same envelope with only the keys of `MINIMAL_DATA_KEYS` (`calls` cut to 16 entries) and the flag `minimal`. */
export function minimalEnvelope(envelope: HookEnvelopeV1): HookEnvelopeV1 {
  const data: Record<string, EnvelopeDataValue> = {};
  for (const key of MINIMAL_DATA_KEYS) {
    const value = envelope.data[key];
    if (value === undefined) continue;
    data[key] = key === 'calls' && Array.isArray(value) ? value.slice(0, MINIMAL_CALLS_MAX) : value;
  }
  const flags = envelope.flags.includes('minimal') ? envelope.flags : [...envelope.flags, 'minimal'];
  return { ...envelope, flags, data };
}

const LF = String.fromCharCode(10);

function encode(envelope: HookEnvelopeV1): Buffer {
  return Buffer.from(JSON.stringify(envelope) + LF, 'utf8');
}

/** The full line, or the minimal one when `forceMinimal` or the full line is over `ENVELOPE_MAX_BYTES` (newline included). */
export function encodeLine(envelope: HookEnvelopeV1, forceMinimal: boolean): Buffer {
  if (!forceMinimal) {
    const full = encode(envelope);
    if (full.length <= ENVELOPE_MAX_BYTES) return full;
  }
  return encode(minimalEnvelope(envelope));
}

function errorCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' ? code : 'ERROR';
}

/** Creates `<workspace>/data/spool` when the workspace itself still exists (a deleted instance is never re-created). */
function ensureSpoolDir(route: HookRouteV1): boolean {
  try {
    if (!statSync(route.workspace).isDirectory()) return false;
    mkdirSync(route.spoolDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function openSegment(route: HookRouteV1, segment: string): number {
  try {
    return openSync(segment, 'a');
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' || !ensureSpoolDir(route)) throw error;
    return openSync(segment, 'a');
  }
}

/**
 * Writes the envelope for `route` into the segment of the UTC hour of `received_at`. A segment at the hard cap is left
 * alone (`full`); at the soft cap the line is the minimal envelope. Errors never escape.
 */
export function appendEnvelope(route: HookRouteV1, envelope: HookEnvelopeV1): SpoolResult {
  let fd: number | null = null;
  try {
    fd = openSegment(route, `${route.spoolDir}/${spoolSegmentName(envelope.received_at)}`);
    const size = fstatSync(fd).size;
    if (size >= SPOOL_SEGMENT_HARD_CAP) return { outcome: 'full', detail: 'hard cap' };
    const line = encodeLine(envelope, size >= SPOOL_SEGMENT_SOFT_CAP);
    const written = writeSync(fd, line);
    return written === line.length ? { outcome: 'written', detail: '' } : { outcome: 'failed', detail: 'short write' };
  } catch (error) {
    return { outcome: 'failed', detail: errorCode(error) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do: the line is written or it is not.
      }
    }
  }
}
