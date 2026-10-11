// The only transaction entry point of the engine (03 4.5, DA-I7, DA-I12): BEGIN IMMEDIATE, the callback, the change
// recorder's flush, COMMIT, and only then the listeners (persist, then publish). The callback is synchronous: no
// transaction spans an `await`; the no-await check lives in write.test.ts (and in the ESLint rule the lead owns).
import { createChangeRecorder, type ChangeRecorder } from './changes.ts';
import { DbError } from './errors.ts';
import type { InstanceDb, RepoContext } from './open.ts';

export interface WriteTx {
  readonly changes: ChangeRecorder;
  /** Epoch ms from the clock of the database, read once when the transaction starts. */
  readonly now: number;
}

interface Subscription {
  readonly listener: (headSeq: number) => void;
}

const subscriptions = new WeakMap<InstanceDb, Set<Subscription>>();
const running = new WeakSet<InstanceDb>();

function publish(db: InstanceDb): void {
  const live = subscriptions.get(db);
  if (live === undefined || live.size === 0) return;
  const head = db.headSeq();
  for (const subscription of [...live]) {
    try {
      subscription.listener(head);
    } catch (error) {
      // The data is committed: one failing listener must neither undo that nor starve the others. The name only: a
      // listener's message can carry request data.
      process.emitWarning(`an onCommitted listener threw ${error instanceof Error ? error.name : 'a non-error'}`, {
        code: 'ON_COMMITTED_LISTENER_FAILED',
      });
    }
  }
}

/**
 * Runs `fn` in one `BEGIN IMMEDIATE` transaction with a fresh `ChangeRecorder`: `fn`, `changes.flush()`, COMMIT, then the
 * `onCommitted` listeners. `fn` must be synchronous (DA-I12); a throw rolls back and publishes nothing. Not re-entrant.
 */
export function withWriteTx<T>(db: InstanceDb, ctx: RepoContext, fn: (tx: WriteTx) => T): T {
  db.assertScope(ctx);
  if (db.mode === 'readonly') throw new DbError('db_readonly', 'a read-only database has no write transaction');
  if (running.has(db)) throw new Error('withWriteTx is not re-entrant: one write transaction at a time (DA-I12)');
  running.add(db);
  let result: T;
  try {
    result = db.driver.transaction(() => {
      const now = db.clock.now();
      const changes = createChangeRecorder(db.driver, now);
      const value = fn({ changes, now });
      changes.flush();
      return value;
    }, 'immediate');
  } finally {
    running.delete(db);
  }
  publish(db);
  return result;
}

/** The stream hub subscribes here (03 9.2). Returns the unsubscribe function. */
export function onCommitted(db: InstanceDb, listener: (headSeq: number) => void): () => void {
  let live = subscriptions.get(db);
  if (live === undefined) {
    live = new Set<Subscription>();
    subscriptions.set(db, live);
  }
  const subscription: Subscription = { listener };
  live.add(subscription);
  const owner = live;
  return () => {
    owner.delete(subscription);
  };
}
