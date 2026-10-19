// The JSON document model (design 01 section 1.9, ADR 0003, ADR 0067).
//
// The model keeps what `JSON.parse` loses, so that rewriting a user's file never churns it: the integer/float
// distinction (decided by the lexeme), integers beyond 2**53 and the order of object entries.

export type JsonDoc =
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  | { k: 'str'; v: string }
  | { k: 'int'; v: bigint }
  | { k: 'float'; v: number }
  | { k: 'arr'; v: JsonDoc[] }
  | { k: 'obj'; v: [string, JsonDoc][] };

/** A document whose top level is an object. */
export type JsonObject = Extract<JsonDoc, { k: 'obj' }>;

/** Options of {@link dumpJson}: the indent-2 file layout or the one-line form with `, ` and `: ` separators. */
export type JsonDumpOptions = { indent: 2 } | { compact: true; escapeNonAscii?: boolean };

/** Thrown by `dumpJson` for a value that cannot be written: a lone surrogate (not valid UTF-8) or a non-finite float. */
export class JsonEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonEncodeError';
  }
}
