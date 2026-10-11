import { describe, expect, it } from 'vitest';

import { DB_ERROR_CODES, DbError, isDbError, type DbErrorCode } from './errors.ts';

// The 21 codes of 03 4.3 and registry 7.4, in the order the registry lists them.
const REGISTRY_CODES: readonly DbErrorCode[] = [
  'db_busy',
  'db_locked',
  'db_not_mcs',
  'db_identity_mismatch',
  'db_corrupt',
  'db_readonly',
  'db_full',
  'db_io',
  'db_cantopen',
  'db_constraint',
  'db_migration_required',
  'db_newer_than_runtime',
  'migration_checksum_mismatch',
  'migration_gap',
  'migration_unknown',
  'migration_failed',
  'migration_fk_violation',
  'migrations_missing',
  'backup_required',
  'backup_failed',
  'scope_mismatch',
];

describe('DbErrorCode (03 4.3, registry 7.4)', () => {
  it('lists exactly the registry codes, in registry order, without duplicates', () => {
    expect([...DB_ERROR_CODES]).toEqual([...REGISTRY_CODES]);
    expect(new Set(DB_ERROR_CODES).size).toBe(DB_ERROR_CODES.length);
  });
});

describe('DbError', () => {
  it('is an Error that carries the code and, when given, constraint, version and sqliteCode', () => {
    const error = new DbError('db_constraint', 'a constraint failed', {
      constraint: 'unique',
      sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DbError);
    expect(error.name).toBe('DbError');
    expect(error.code).toBe('db_constraint');
    expect(error.message).toBe('a constraint failed');
    expect(error.constraint).toBe('unique');
    expect(error.sqliteCode).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(error.version).toBeUndefined();
  });

  it('records the migration version of a migration error', () => {
    const error = new DbError('migration_failed', 'migration 2 failed', { version: 2, sqliteCode: 'SQLITE_ERROR' });
    expect(error.version).toBe(2);
    expect(error.constraint).toBeUndefined();
  });

  it('keeps the original error as cause when one is given', () => {
    const cause = new Error('low level');
    expect(new DbError('db_io', 'io', { cause }).cause).toBe(cause);
    expect(new DbError('db_io', 'io').cause).toBeUndefined();
  });

  it('isDbError narrows by instance and, optionally, by code', () => {
    const error: unknown = new DbError('db_busy', 'busy');
    expect(isDbError(error)).toBe(true);
    expect(isDbError(error, 'db_busy')).toBe(true);
    expect(isDbError(error, 'db_locked')).toBe(false);
    expect(isDbError(new Error('db_busy'))).toBe(false);
    expect(isDbError(null)).toBe(false);
    expect(isDbError({ code: 'db_busy' })).toBe(false);
  });
});
