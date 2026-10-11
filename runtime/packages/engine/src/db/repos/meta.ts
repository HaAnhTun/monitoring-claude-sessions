// `meta` (03 3.3): small key/value facts of the instance (identity, schema bookkeeping, liveness marks). SQL only.
import type { InstanceDb, RepoContext } from '../open.ts';
import type { WriteTx } from '../write.ts';

/** The identity row is written once by the migration runner and never again (DA-I3). */
const IMMUTABLE_KEYS: ReadonlySet<string> = new Set(['instance_id']);

function refuseImmutable(key: string): void {
  if (IMMUTABLE_KEYS.has(key)) throw new RangeError(`meta key ${key} is written by the migration runner only`);
}

export class MetaRepo {
  private readonly db: InstanceDb;

  constructor(db: InstanceDb) {
    this.db = db;
  }

  get(ctx: RepoContext, key: string): string | undefined {
    this.db.assertScope(ctx);
    return this.db.driver.prepare<{ value: string }>('SELECT value FROM meta WHERE key = :key').get({ key })?.value;
  }

  all(ctx: RepoContext): Map<string, string> {
    this.db.assertScope(ctx);
    const rows = this.db.driver
      .prepare<{ key: string; value: string }>('SELECT key, value FROM meta ORDER BY key')
      .all();
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  set(ctx: RepoContext, _tx: WriteTx, key: string, value: string): void {
    this.db.assertScope(ctx);
    refuseImmutable(key);
    this.db.driver
      .prepare(
        'INSERT INTO meta (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run({ key, value });
  }

  /** True when the key existed. */
  delete(ctx: RepoContext, _tx: WriteTx, key: string): boolean {
    this.db.assertScope(ctx);
    refuseImmutable(key);
    return this.db.driver.prepare('DELETE FROM meta WHERE key = :key').run({ key }).changes > 0;
  }
}
