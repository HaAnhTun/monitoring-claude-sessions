import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROUTES_MAX_FILES, ROUTE_FILE_MAX_BYTES, type HookRouteV1 } from '@mcs/shared/protocol';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { parseRoute, readRoutes, type RouteProblem } from './routes-reader.ts';

const makeTemp = useTempDirs();
const ID = '6a0f3c1e-1b2c-4d3e-8f40-0123456789ab';

function route(overrides: Partial<HookRouteV1> = {}): HookRouteV1 {
  return {
    v: 1,
    instanceId: ID,
    workspace: 'C:/ws',
    spoolDir: 'C:/ws/data/spool',
    stateFile: 'C:/ws/state.json',
    enabled: true,
    match: { transcriptsDirs: ['c:/p'], sessionIds: [] },
    stoppedAt: null,
    spoolUntil: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe('parseRoute', () => {
  it('accepts a valid route named after its instance id', () => {
    expect(parseRoute(JSON.stringify(route()), `${ID}.json`)).toEqual(route());
  });

  const tooMany = route({ match: { transcriptsDirs: Array<string>(9).fill('x'), sessionIds: [] } });
  it.each([
    ['invalid JSON', '{ nope', `${ID}.json`],
    ['an array', '[]', `${ID}.json`],
    ['another version', JSON.stringify({ ...route(), v: 2 }), `${ID}.json`],
    ['a file name that is not the instance id', JSON.stringify(route()), 'other.json'],
    ['an instance id that is not a uuid', JSON.stringify(route({ instanceId: 'abc' })), 'abc.json'],
    ['more than 8 transcripts dirs', JSON.stringify(tooMany), `${ID}.json`],
    [
      'a non-string session id',
      JSON.stringify({ ...route(), match: { transcriptsDirs: [], sessionIds: [1] } }),
      `${ID}.json`,
    ],
    ['a stoppedAt that is not a time', JSON.stringify({ ...route(), stoppedAt: 'now' }), `${ID}.json`],
    ['enabled as a string', JSON.stringify({ ...route(), enabled: 'yes' }), `${ID}.json`],
  ])('rejects %s', (_name, text, fileName) => {
    expect(parseRoute(text, fileName)).toBeNull();
  });
});

describe('readRoutes', () => {
  function home(): string {
    const dir = makeTemp('routes').path;
    mkdirSync(join(dir, 'routes'));
    return dir;
  }

  it('returns valid routes and reports the invalid ones by file name', () => {
    const dir = home();
    writeFileSync(join(dir, 'routes', `${ID}.json`), JSON.stringify(route()));
    writeFileSync(join(dir, 'routes', 'broken.json'), '{');
    writeFileSync(join(dir, 'routes', 'notes.txt'), 'ignored');
    const problems: RouteProblem[] = [];
    expect(readRoutes(dir, (problem) => problems.push(problem))).toEqual([route()]);
    expect(problems).toEqual([{ code: 'ROUTE_INVALID', detail: 'broken.json' }]);
  });

  it('is silent when the routes folder does not exist and reports a routes path that is a file', () => {
    const dir = makeTemp('routes').path;
    const problems: RouteProblem[] = [];
    expect(readRoutes(dir, (problem) => problems.push(problem))).toEqual([]);
    expect(problems).toEqual([]);
    writeFileSync(join(dir, 'routes'), 'x');
    expect(readRoutes(dir, (problem) => problems.push(problem))).toEqual([]);
    expect(problems.map((problem) => problem.code)).toEqual(['ROUTES_UNREADABLE']);
  });

  it('reads at most 64 files and rejects a file over 16 KiB', () => {
    const dir = home();
    for (let i = 0; i < ROUTES_MAX_FILES + 6; i += 1) {
      writeFileSync(join(dir, 'routes', `f${String(i).padStart(3, '0')}.json`), '{}');
    }
    const problems: RouteProblem[] = [];
    readRoutes(dir, (problem) => problems.push(problem));
    expect(problems).toHaveLength(ROUTES_MAX_FILES);
    const big = home();
    const oversized = route({ workspace: 'x'.repeat(ROUTE_FILE_MAX_BYTES) });
    writeFileSync(join(big, 'routes', `${ID}.json`), JSON.stringify(oversized));
    const bigProblems: RouteProblem[] = [];
    expect(readRoutes(big, (problem) => bigProblems.push(problem))).toEqual([]);
    expect(bigProblems).toEqual([{ code: 'ROUTE_INVALID', detail: `${ID}.json` }]);
  });
});
