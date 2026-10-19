// DA-T-A-5 (03 19.6, 8.4), the pure part: the median over finished durations and the failure percentage. The grouped counts are
// proved against `tool_calls` in `test/analytics.int.test.ts`.
import { describe, expect, it } from 'vitest';

import { failurePercent, medianOf } from './tools.ts';

describe('medianOf', () => {
  it.each([
    [[], null],
    [[7], 7],
    [[1, 9], 5],
    [[1, 2, 100], 2],
    [[1, 2, 3, 100], 2.5],
    [[0, 0, 0], 0],
  ])('the median of %j is %j', (sorted, expected) => {
    expect(medianOf(sorted)).toBe(expected);
  });
});

describe('failurePercent', () => {
  it.each([
    // failed, calls, pending, expected
    [1, 3, 0, 33.3],
    [1, 4, 2, 50], // pending calls are not in the denominator
    [0, 4, 4, null], // nothing has finished: no percentage (a pending call is never a failure)
    [0, 0, 0, null],
    [2, 2, 0, 100],
    [0, 5, 0, 0],
    [2, 3, 0, 66.7],
  ])('%i failed of %i calls with %i pending is %j', (failed, calls, pending, expected) => {
    expect(failurePercent(failed, calls, pending)).toBe(expected);
  });
});
