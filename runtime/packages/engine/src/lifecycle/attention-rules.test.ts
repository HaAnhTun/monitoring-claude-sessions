// Drift guard (ADR 0107): every rule id the lifecycle can answer has a row in the attention table of `@mcs/shared`, and
// the table names no rule the lifecycle does not have. Reads `derive-session.ts` as text on purpose: a rule added there
// cannot ship unclassified.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ATTENTION_RULES } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

describe('attention rules and lifecycle rules', () => {
  it('are the same set of rule ids', () => {
    const source = readFileSync(fileURLToPath(new URL('./derive-session.ts', import.meta.url)), 'utf8');
    const literals = [...source.matchAll(/\bruleId:\s*'([^']+)'/g)].map((match) => match[1] ?? '');
    const engineRules = [...new Set(literals)].sort();
    // Every `ruleId:` of the file is a plain literal: a computed one would escape this scan.
    expect(literals.length).toBe([...source.matchAll(/\bruleId:/g)].length);
    expect(engineRules.length).toBeGreaterThan(20);
    expect(engineRules).toEqual(Object.keys(ATTENTION_RULES).sort());
  });
});
