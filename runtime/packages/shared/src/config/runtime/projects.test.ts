import { describe, expect, it } from 'vitest';

import { PROJECT_SCOPES, ProjectsSectionKeys, ProjectsSectionSchema } from './projects.ts';
import { RuntimeFileSchema, RuntimeOverridesSchema } from './index.ts';

const accepts = (key: string, value: unknown) =>
  RuntimeOverridesSchema.safeParse({ schema_version: 1, projects: { [key]: value } }).success;

describe('projects section (TC-CFG-02, design 03 2.1)', () => {
  it('exports the scopes and has the eleven keys with their defaults', () => {
    expect([...PROJECT_SCOPES]).toEqual(['auto', 'repo', 'all']);
    expect(Object.keys(ProjectsSectionKeys)).toHaveLength(11);
    expect(ProjectsSectionSchema.parse(undefined)).toEqual({
      scope: 'auto',
      fullSweepIntervalMs: 60_000,
      coldStatIntervalMs: 10_000,
      catalogIntervalMs: 30_000,
      daMemoryDir: null,
      daCacheMs: 3000,
      userFoldersMax: 200,
      linkPollMs: 250,
      linkSlowPollMs: 2000,
      linkFastWindowMs: 30_000,
      linkStartToleranceMs: 2000,
    });
  });

  it('is part of the merged file and of the overrides file', () => {
    expect(RuntimeFileSchema.parse({ schema_version: 1 }).projects.scope).toBe('auto');
    expect(RuntimeOverridesSchema.parse({ schema_version: 1, projects: { scope: 'all' } })).toEqual({
      schema_version: 1,
      projects: { scope: 'all' },
    });
  });

  it('refuses an unknown key', () => {
    expect(accepts('folders', 3)).toBe(false);
    expect(accepts('Scope', 'all')).toBe(false);
    expect(ProjectsSectionSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });

  it('scope: auto, repo or all', () => {
    for (const scope of PROJECT_SCOPES) expect(accepts('scope', scope)).toBe(true);
    expect(accepts('scope', 'everything')).toBe(false);
    expect(accepts('scope', 'ALL')).toBe(false);
    expect(accepts('scope', true)).toBe(false);
    expect(accepts('scope', null)).toBe(false);
  });

  const RANGES: readonly (readonly [string, number, number])[] = [
    ['fullSweepIntervalMs', 5000, 3_600_000],
    ['coldStatIntervalMs', 1000, 600_000],
    ['catalogIntervalMs', 5000, 600_000],
    ['daCacheMs', 500, 60_000],
    ['userFoldersMax', 1, 1000],
    ['linkPollMs', 100, 5000],
    ['linkSlowPollMs', 500, 60_000],
    ['linkFastWindowMs', 5000, 600_000],
    ['linkStartToleranceMs', 0, 30_000],
  ];

  it.each(RANGES)('%s accepts %i and %i and refuses the values just outside', (key, lo, hi) => {
    expect(accepts(key, lo)).toBe(true);
    expect(accepts(key, hi)).toBe(true);
    expect(accepts(key, lo - 1)).toBe(false);
    expect(accepts(key, hi + 1)).toBe(false);
    expect(accepts(key, lo + 0.5)).toBe(false);
    expect(accepts(key, String(lo))).toBe(false);
  });

  it('daMemoryDir: null or a non-empty string without control characters', () => {
    expect(accepts('daMemoryDir', null)).toBe(true);
    expect(accepts('daMemoryDir', 'C:/data/memory')).toBe(true);
    expect(accepts('daMemoryDir', '')).toBe(false);
    expect(accepts('daMemoryDir', 'a\u0000b')).toBe(false);
    expect(accepts('daMemoryDir', 'a\nb')).toBe(false);
    expect(accepts('daMemoryDir', 'x'.repeat(1025))).toBe(false);
    expect(accepts('daMemoryDir', 5)).toBe(false);
  });
});
