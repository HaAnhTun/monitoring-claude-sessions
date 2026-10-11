import { describe, expect, it } from 'vitest';

import { MAX_LINE_BYTES } from './limits.ts';

describe('limits', () => {
  it('caps one transcript or spool line at 64 MiB (98 10.1, I-32)', () => {
    expect(MAX_LINE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_LINE_BYTES).toBe(67_108_864);
  });
});
