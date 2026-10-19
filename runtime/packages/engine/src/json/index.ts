// The JSON document module (design 01 section 1.9, ADR 0003, ADR 0067). The file writer `writeJsonFile` lives in
// `workspace/fsio.ts` (01 1.2) and writes `jsonFileText(value)` through the atomic-replace primitive.
export type { JsonDoc, JsonDumpOptions, JsonObject } from './value.ts';
export { JsonEncodeError } from './value.ts';
export { formatFloat } from './number.ts';
export { JsonSyntaxError, parseJson } from './parse.ts';
export { dumpJson, jsonFileText, messageJson } from './write.ts';
export { fromPlain, toPlain } from './convert.ts';
export { jsonEquals } from './equals.ts';
export { quoteText, shortJson } from './quote.ts';
