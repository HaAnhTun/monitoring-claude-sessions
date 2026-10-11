import { McsError } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

import { fromPlain, toPlain, type PyJsonValue } from '../pyjson/index.ts';
import {
  FILE_MIGRATIONS,
  applyMigrations,
  assertMigrationRegistry,
  latestFileVersion,
  planFileMigrations,
  type FileMigration,
} from './migrations.ts';

function step(file: FileMigration['file'], from: number, to: number, add: string): FileMigration {
  return {
    file,
    from,
    to,
    describe: `add ${add}`,
    apply(doc: PyJsonValue): PyJsonValue {
      const plain = toPlain(doc);
      if (typeof plain !== 'object' || plain === null || Array.isArray(plain)) throw new Error('not an object');
      return fromPlain({ ...plain, schema_version: to, [add]: true });
    },
  };
}

function failure(run: () => unknown): McsError {
  try {
    run();
  } catch (e) {
    if (e instanceof McsError) return e;
    throw e;
  }
  throw new Error('expected McsError');
}

describe('FILE_MIGRATIONS in v1', () => {
  it('is empty, and every file is at version 1', () => {
    expect(FILE_MIGRATIONS).toEqual([]);
    for (const file of ['config.json', 'runtime.json', 'instance.json'] as const) {
      expect(latestFileVersion(file)).toBe(1);
      expect(planFileMigrations(file, 1)).toEqual([]);
    }
  });

  it('refuses a file newer than the newest known version with CONFIG_SCHEMA_UNSUPPORTED', () => {
    const e = failure(() => planFileMigrations('runtime.json', 7));
    expect(e.code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
    expect(e.message).toContain('runtime.json');
    expect(e.message).toContain('7');
  });

  it('refuses an invalid version number', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(failure(() => planFileMigrations('config.json', bad)).code, String(bad)).toBe('CONFIG_SCHEMA_UNSUPPORTED');
    }
  });
});

describe('planFileMigrations with a registry', () => {
  const registry = [step('config.json', 1, 2, 'a'), step('config.json', 2, 3, 'b'), step('runtime.json', 1, 2, 'c')];

  it('computes the newest supported version per file', () => {
    expect(latestFileVersion('config.json', registry)).toBe(3);
    expect(latestFileVersion('runtime.json', registry)).toBe(2);
    expect(latestFileVersion('instance.json', registry)).toBe(1);
  });

  it('plans the chain from the current version, in order', () => {
    expect(planFileMigrations('config.json', 1, registry).map((s) => `${String(s.from)}>${String(s.to)}`)).toEqual([
      '1>2',
      '2>3',
    ]);
    expect(planFileMigrations('config.json', 2, registry).map((s) => s.describe)).toEqual(['add b']);
  });

  it('plans nothing for a file that is current, and for a file with no step', () => {
    expect(planFileMigrations('config.json', 3, registry)).toEqual([]);
    expect(planFileMigrations('instance.json', 1, registry)).toEqual([]);
  });

  it('refuses a version beyond the newest one', () => {
    expect(failure(() => planFileMigrations('runtime.json', 3, registry)).code).toBe('CONFIG_SCHEMA_UNSUPPORTED');
  });

  it('applies the planned steps in order and ends at the newest version', () => {
    const doc = fromPlain({ schema_version: 1, keep: 'x' });
    const out = applyMigrations(doc, planFileMigrations('config.json', 1, registry));
    expect(toPlain(out)).toEqual({ schema_version: 3, keep: 'x', a: true, b: true });
    expect(toPlain(doc)).toEqual({ schema_version: 1, keep: 'x' });
  });

  it('applying no step returns the same document', () => {
    const doc = fromPlain({ schema_version: 1 });
    expect(applyMigrations(doc, [])).toBe(doc);
  });
});

describe('assertMigrationRegistry', () => {
  it('accepts the shipped (empty) registry and a contiguous one', () => {
    expect(() => {
      assertMigrationRegistry(FILE_MIGRATIONS);
    }).not.toThrow();
    expect(() => {
      assertMigrationRegistry([step('config.json', 1, 2, 'a'), step('config.json', 2, 3, 'b')]);
    }).not.toThrow();
  });

  it('rejects a step that does not move forward, a jump of more than one version, a fork and a gap', () => {
    expect(() => {
      assertMigrationRegistry([step('config.json', 2, 2, 'a')]);
    }).toThrow(/exactly one version/);
    expect(() => {
      assertMigrationRegistry([step('config.json', 1, 3, 'a')]);
    }).toThrow(/exactly one version/);
    expect(() => {
      assertMigrationRegistry([step('config.json', 1, 2, 'a'), step('config.json', 1, 2, 'b')]);
    }).toThrow(/twice/);
    expect(() => {
      assertMigrationRegistry([step('config.json', 1, 2, 'a'), step('config.json', 3, 4, 'b')]);
    }).toThrow(/gap/);
  });
});
