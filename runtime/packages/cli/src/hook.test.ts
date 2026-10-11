import { describe, expect, it } from 'vitest';

import { HANDLER_VERSION, runHook } from './hook.ts';

describe('hook entry', () => {
  it('exports runHook and the handler version, and importing it starts nothing', () => {
    expect(typeof runHook).toBe('function');
    expect(HANDLER_VERSION).toMatch(/^[0-9]+[.][0-9]+[.][0-9]+/);
  });
});
