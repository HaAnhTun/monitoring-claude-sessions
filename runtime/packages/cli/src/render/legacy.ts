// Legacy JSON renderer (01 6.2): the five commands whose legacy version printed JSON keep printing the same shape, pretty
// printed with two-space indentation and non-ASCII text raw (Python `json.dumps(x, indent=2, ensure_ascii=False)`). Parity
// with the legacy output is defined on keys and values, not bytes.
import { printJson } from '../io/terminal.ts';

export function renderLegacy(value: unknown): void {
  printJson(value, 2);
}
