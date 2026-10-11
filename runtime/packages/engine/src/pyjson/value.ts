// Python-compatible JSON value model (design 01 section 1.9, ADR 0003).
//
// The model keeps what `JSON.parse` loses: the int/float distinction (decided by the lexeme, like Python's
// `json.loads`), integers beyond 2**53, and the order of object entries.

export type PyJsonValue =
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  | { k: 'str'; v: string }
  | { k: 'int'; v: bigint }
  | { k: 'float'; v: number }
  | { k: 'arr'; v: PyJsonValue[] }
  | { k: 'obj'; v: [string, PyJsonValue][] };

/** Options of {@link dumpPyJson}: Python's `indent=2` form or the compact `(', ', ': ')` form. */
export type PyJsonDumpOptions = { indent: 2 } | { compact: true; asciiOnly?: boolean };

/** Thrown by `dumpPyJson` for a value Python could not write either (a lone surrogate in a UTF-8 file). */
export class PyJsonEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PyJsonEncodeError';
  }
}
