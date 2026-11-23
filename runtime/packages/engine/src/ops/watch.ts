// `ops.watch` (ADR 0108): the operations behind `events` and `wait`. Both only read: the durable change stream of a running
// instance through `openChangeFeed`, and the two open reads `getSession` and `explainCompletion` through an `InstanceReader`.
//   - `followEvents` turns the frames of the stream into `caw.event/1` lines (ids, states and times; never a label or a folder).
//   - `waitFor` drives the pure wait machine of `@mcs/shared`: it reads the session first (the answer says the seq it was read
//     at), then follows the stream from that seq, so no change between the read and the subscription is lost. A session upsert
//     without data means "not readable now" and is read again, a delete is `missing`, a reset reads again, and `completed` is
//     decided by the completion check alone. When the instance has no free stream the wait polls the session every 3 s.
// Nothing here prints; time comes from the clock of the context and from the `sleep` of the dependencies.
import {
  CLI_EVENT_SCHEMA,
  McsError,
  SessionIdSchema,
  attentionSummaryOf,
  cliEventSessionOf,
  createWaitMachine,
  waitStateOf,
  type ChangeKind,
  type CliEvent,
  type StateAssessment,
  type StreamChange,
  type WaitResult,
  type WaitStep,
  type WaitUntil,
} from '@mcs/shared';

import {
  abortableSleep,
  openChangeFeed,
  type ChangeFeedDeps,
  type ChangeFeedEvent,
  type FeedSleep,
} from '../reader/change-feed.ts';
import { readerReasonOf } from '../reader/open.ts';
import { withReader, type DataDeps } from './data.ts';
import { openWorkspace, type OpContext } from './workspace.ts';

/** What a test can replace: everything of `DataDeps`, the feed and the timer. */
export interface WatchDeps extends DataDeps {
  /** Replaces `openChangeFeed` (a test hands out a scripted feed). */
  readonly openFeed?: typeof openChangeFeed;
  readonly sleep?: FeedSleep;
}

function feedDepsOf(ctx: OpContext, deps: WatchDeps): ChangeFeedDeps {
  return {
    runtimeDir: ctx.runtimeDir,
    ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    ...(deps.openStream === undefined ? {} : { openStream: deps.openStream }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  };
}

// ---- events ----------------------------------------------------------------------------------------------------------------------

export interface FollowInput {
  readonly task: string;
  /** Stay on the stream; without it the generator ends after the `hello` line, or after the replay of `since`. */
  readonly follow: boolean;
  /** Replay the change log after this seq first. */
  readonly since?: number;
  /** The kinds of change to report; `null` reports every kind. */
  readonly kinds: readonly ChangeKind[] | null;
  /** Ends the generator quietly (the reader of the output went away). */
  readonly signal?: AbortSignal;
}

function changeLineOf(change: StreamChange): CliEvent {
  return {
    schema: CLI_EVENT_SCHEMA,
    type: 'change',
    seq: change.seq,
    at: change.at,
    kind: change.kind,
    op: change.op,
    sessionId: change.sessionId,
    session:
      change.kind === 'session' && change.op === 'upsert' && change.data !== null
        ? cliEventSessionOf(change.data.state)
        : null,
  };
}

/**
 * The lines of `events`: `hello` first, then one `change` per frame of a reported kind and a `reset` whenever the server could
 * not serve the cursor. Without `follow` a replay ends with an `end` line once the head of the `hello` is reached (or at the
 * first heartbeat, should the last change never arrive). Heartbeats and the `hello` of a reconnect are not reported.
 */
export async function* followEvents(
  ctx: OpContext,
  input: FollowInput,
  deps: WatchDeps = {},
): AsyncGenerator<CliEvent, void, void> {
  const ws = await openWorkspace(ctx, input.task);
  const feed = (deps.openFeed ?? openChangeFeed)(ws, feedDepsOf(ctx, deps), {
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  /** A replay without `follow`: the head it has to reach. */
  let target: number | null = null;
  let count = 0;
  const end = (headSeq: number): CliEvent => ({ schema: CLI_EVENT_SCHEMA, type: 'end', headSeq, count });

  for await (const event of feed) {
    if (event.type === 'hello') {
      if (event.reconnect) continue;
      const { instanceId, epoch, headSeq, serverTime } = event.hello;
      yield { schema: CLI_EVENT_SCHEMA, type: 'hello', instanceId, epoch, headSeq, serverTime };
      if (input.follow) continue;
      if (input.since === undefined) return;
      if (input.since === headSeq) {
        yield end(headSeq);
        return;
      }
      target = headSeq;
    } else if (event.type === 'change') {
      const { change } = event;
      if (input.kinds === null || input.kinds.includes(change.kind)) {
        count += 1;
        yield changeLineOf(change);
      }
      if (target !== null && change.seq >= target) {
        yield end(target);
        return;
      }
    } else if (event.type === 'reset') {
      yield { schema: CLI_EVENT_SCHEMA, type: 'reset', reason: event.reset.reason, headSeq: event.reset.headSeq };
      if (target !== null) {
        // the cursor was not served: the stream restarted at the head, so there is nothing left to replay
        yield end(event.reset.headSeq);
        return;
      }
    } else if (target !== null) {
      yield end(target);
      return;
    }
  }
}

// ---- wait ------------------------------------------------------------------------------------------------------------------------

export interface WaitInput {
  readonly task: string;
  readonly sessionId: string;
  readonly until: WaitUntil;
  readonly timeoutMs: number;
  readonly holdMs: number;
  readonly next: boolean;
  readonly appearMs: number;
  readonly signal?: AbortSignal;
}

/** How often a wait reads the session when the instance has no free stream. */
export const WAIT_POLL_MS = 3000;
const MAX_TIMER_MS = 2 ** 31 - 1;

type Arrived =
  | { readonly kind: 'event'; readonly result: IteratorResult<ChangeFeedEvent, void> }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Waits until the condition `until` holds for the session, the timeout passes, the session is over without it, or the session
 * never appears; the result says which. Throws `McsError` for everything else (`INSTANCE_NOT_RUNNING` when there is no running
 * instance to follow, `USAGE` for an id that is not one). A timeout of 0 reads once and answers, also from a stopped instance.
 */
export async function waitFor(ctx: OpContext, input: WaitInput, deps: WatchDeps = {}): Promise<WaitResult> {
  const { sessionId } = input;
  if (!SessionIdSchema.safeParse(sessionId).success) {
    throw new McsError('USAGE', 'the session id is not valid', { details: { reason: 'validation_failed' } });
  }
  const ws = await openWorkspace(ctx, input.task);
  const { clock } = ctx;
  const sleep = deps.sleep ?? abortableSleep;
  const startedAt = clock.now();
  const machine = createWaitMachine(
    {
      until: input.until,
      holdMs: input.holdMs,
      next: input.next,
      appearMs: input.appearMs,
      timeoutMs: input.timeoutMs,
    },
    startedAt,
  );
  const seen: { state: StateAssessment | null; completion: WaitResult['completion']; polling: boolean } = {
    state: null,
    completion: null,
    polling: false,
  };

  const feedState = (state: StateAssessment): WaitStep => {
    seen.state = state;
    return machine.feed(state, clock.now());
  };

  /** Reads the session and feeds the machine; `asOfSeq` is the seq the answer was read at (`null` without a session). */
  const readSession = async (): Promise<{ readonly step: WaitStep; readonly asOfSeq: number | null }> => {
    const detail = await withReader(ctx, input.task, deps, (reader) => {
      // a poll has no stream that would notice a stopped instance, and its database would answer the same state for ever
      if (seen.polling && reader.mode !== 'api') {
        throw new McsError('INSTANCE_NOT_RUNNING', 'the instance stopped while the session was waited for', {
          details: { reason: 'not_running' },
        });
      }
      return reader.session(sessionId);
    });
    if (detail === null) return { step: machine.feed('missing', clock.now()), asOfSeq: null };
    return { step: feedState(detail.state), asOfSeq: detail.asOfSeq };
  };

  /** Asks the completion check for as long as the machine wants its answer. */
  const prove = async (step: WaitStep): Promise<WaitStep> => {
    let current = step;
    while (current.status === 'pending' && current.needsProof) {
      try {
        const answer = await withReader(ctx, input.task, deps, (reader) => reader.explainCompletion({ sessionId }));
        seen.completion = { outcome: answer.outcome, ruleId: answer.ruleId };
        current = machine.proof(answer.outcome, clock.now());
      } catch (error) {
        if (readerReasonOf(error) !== 'target_not_found') throw error;
        current = machine.feed('missing', clock.now());
      }
    }
    return current;
  };

  const resultOf = (step: Extract<WaitStep, { status: 'done' }>): WaitResult => ({
    outcome: step.outcome,
    until: input.until,
    sessionId,
    state: seen.state === null ? null : waitStateOf(seen.state),
    attention: seen.state === null ? null : attentionSummaryOf(seen.state),
    completion: seen.completion,
    waitedMs: Math.max(0, clock.now() - startedAt),
    alreadyTrue: step.alreadyTrue,
  });

  const inner = new AbortController();
  const forward = (): void => {
    inner.abort();
  };
  input.signal?.addEventListener('abort', forward, { once: true });
  let feed: AsyncGenerator<ChangeFeedEvent, void, void> | null = null;
  /** The next frame of the feed, asked for once and kept across the timers that fire before it arrives. */
  let pending: Promise<Arrived> | null = null;
  const pull = (from: AsyncGenerator<ChangeFeedEvent, void, void>): void => {
    pending = from.next().then(
      (result): Arrived => ({ kind: 'event', result }),
      (error: unknown): Arrived => ({ kind: 'failed', error }),
    );
  };
  /** The next frame, or `null` when `ms` passed first. */
  const arrive = async (ms: number): Promise<Arrived | null> => {
    const timer = new AbortController();
    // a timer cannot be longer than 2^31 - 1 ms; a wake that comes early only looks at the time again
    const slept = sleep(Math.min(Math.max(0, ms), MAX_TIMER_MS), timer.signal).then(() => null);
    try {
      return await (pending === null ? slept : Promise.race([pending, slept]));
    } finally {
      timer.abort();
    }
  };

  try {
    const first = await readSession();
    let step = await prove(first.step);
    if (step.status === 'done') return resultOf(step);

    // subscribe at the seq of the read; a session that is not there yet is read again once the stream is open
    let readOnHello = first.asOfSeq === null;
    let pollAt: number | null = null;
    feed = (deps.openFeed ?? openChangeFeed)(ws, feedDepsOf(ctx, deps), {
      ...(first.asOfSeq === null ? {} : { since: first.asOfSeq }),
      signal: inner.signal,
    });
    pull(feed);

    for (;;) {
      step = await prove(step);
      if (step.status === 'done') return resultOf(step);
      const wakeAt = Math.min(step.wakeAt ?? Number.POSITIVE_INFINITY, pollAt ?? Number.POSITIVE_INFINITY);
      const arrived = await arrive(wakeAt - clock.now());
      if (arrived === null) {
        if (pollAt !== null && clock.now() >= pollAt) {
          pollAt = clock.now() + WAIT_POLL_MS;
          step = (await readSession()).step;
        } else {
          step = machine.tick(clock.now());
        }
        continue;
      }
      if (arrived.kind === 'failed') {
        if (readerReasonOf(arrived.error) !== 'stream_limit') throw arrived.error;
        // every stream of the instance is taken: read the session on a timer instead
        feed = null;
        pending = null;
        seen.polling = true;
        pollAt = clock.now() + WAIT_POLL_MS;
        step = (await readSession()).step;
        continue;
      }
      if (arrived.result.done === true) {
        throw new McsError('API_ERROR', 'the wait was interrupted', { details: { reason: 'aborted' } });
      }
      if (feed !== null) pull(feed);
      const event = arrived.result.value;
      if (event.type === 'reset' || (event.type === 'hello' && readOnHello && !event.reconnect)) {
        readOnHello = false;
        step = (await readSession()).step;
      } else if (event.type === 'change' && event.change.kind === 'session' && event.change.sessionId === sessionId) {
        const { change } = event;
        if (change.op === 'delete') step = machine.feed('missing', clock.now());
        else if (change.data === null) step = (await readSession()).step;
        else step = feedState(change.data.state);
      } else {
        step = machine.tick(clock.now());
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', forward);
    inner.abort();
    // the abort ends the feed; its `return` only makes sure of it and never matters to the result
    void feed?.return(undefined).catch(() => undefined);
  }
}
