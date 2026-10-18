# 0003 Python-compatible JSON reader/writer for shared workspace files

Status: Amended by 0067 (proposed Phase 1, 2026-10-11). Owner: instances/config/ops design (`docs/design/01-instances-config-ops.md` section 1.9).

## Context
Both engines rewrite `config.json` and write audit summaries. The legacy engine uses `json.load` and `json.dump(indent=2,
ensure_ascii=False)` + newline, and `json.dumps(v, ensure_ascii=False)` for summaries. JavaScript `JSON.parse`/`JSON.stringify` differ in
number formatting (`24.0` vs `24`, `1e+16` vs `10000000000000000`), integer-like key order, big-integer precision and compact separators.
Byte compatibility of shared files is a requirement (INV-02).

## Decision
- One module `pyjson`: an ordered parser (keeps key order, duplicate keys like Python, int vs float by lexeme, BigInt for ints, accepts
  `NaN`/`Infinity` tokens which validation then refuses), a writer reproducing Python's indent-2 and compact (`, ` / `: `) forms with
  `ensure_ascii=False` (and `True` for validation messages), `pyFloatRepr` (shortest digits from `toExponential()`, Python thresholds
  `exp < -4 || exp >= 16`, `.0` for integral floats), Python equality for no-op detection, Python `repr` for messages.
- Every JSON file in a workspace is written through it (Node-only files too, for uniformity), via `writePyJsonFile`
  (`workspace/fsio.ts`) on top of the one atomic-replace primitive `platform/fsx.ts` `atomicWriteFile` (design 06 4.3, ADR 0058;
  revision 2, critic issue I-28). `JSON.stringify` is never used for a workspace JSON file.

## Consequences
- A configure sequence produces byte-identical `config.json` and audit text in both engines (parity test T-XE-02).
- Slightly more code than `JSON.stringify`, fully covered by generated golden tests.

## Alternatives rejected
- `JSON.stringify(x, null, 2)`: 12.8% of golden number cases differ; key order changes for integer-like keys.
- `JSON.parse` with source-text access (reviver `context.source`): keeps number lexemes but not key order, and does not normalize like
  Python's load/dump cycle.

## Evidence
- `D:/mvp/private/scratch/mcs-v3/instances-ops/e6/gen.py` + `check.mjs`, 2026-10-11, Python 3.14.3 / Node 24.14.1: 26,016 number
  lexemes (fixed list, 20,000 random bit-pattern doubles, 3,000 floats, big integers): emulation 0 mismatches, plain JS 3,340 mismatches;
  compact separators confirmed (`{"a": 1, "b": [1, 2.0]}` vs `{"a":1,"b":[1,2]}`).
