// The access service of the user instance (CAW design 02 4.1 and 4.2, amendments A1 to A3, ADR 0084). It is HTTP-free and in
// memory only: the cookies, the guard and the routes live in the server and ask it.
//   - A ticket is a one-use access code (32 random bytes, 43 characters) that lives 120 seconds; at most four are outstanding.
//   - Exchanging a ticket mints a credential (another 32 random bytes) that the server puts into an HttpOnly cookie. A credential
//     ends after 12 hours without use or 24 hours after sign-in, whichever comes first; at most 16 are live (the oldest goes).
//   - Only SHA-256 hashes are kept: neither a code nor a credential nor the control token is stored. A candidate is hashed and
//     compared in constant time against every outstanding ticket, with no early exit.
//   - The failure limiter bounds noise (8 wrong codes in 60 seconds), it must not lock the owner out: a valid code redeems even
//     while it is tripped, and only wrong codes are answered `rate_limited`.
//   - `verifyBearer` takes the control token of `run/control.token` as `Authorization: Bearer <token>` for the `reader` routes.
//   - A credential that is revoked, dropped at the cap or expired is announced to the listeners, so sockets and event streams close.
// Nothing here logs: a code, a credential and a token never leave this module except in the return value of the call that made them.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Clock } from '@mcs/shared';
import { ACCESS_CODE_RE } from '@mcs/shared/protocol';

/** The limits of the service; a test shortens them through `AccessServiceOptions.limits`. All times in milliseconds. */
export interface AccessLimits {
  /** How long a ticket can be redeemed. */
  readonly ticketTtlMs: number;
  /** Outstanding tickets; a new one drops the oldest. */
  readonly maxTickets: number;
  /** Live credentials; a new one revokes the oldest. */
  readonly maxCredentials: number;
  /** A credential unused for this long ends. */
  readonly credentialIdleMs: number;
  /** A credential ends this long after sign-in, whatever its use. */
  readonly credentialMaxAgeMs: number;
  /** The sliding window of the failure limiter. */
  readonly failureWindowMs: number;
  /** Wrong codes inside the window after which wrong codes are `rate_limited`. */
  readonly maxFailures: number;
  /** The idle clock of a credential moves at most this often (a use more often than this does not touch it). */
  readonly touchIntervalMs: number;
}

export const ACCESS_LIMITS: AccessLimits = {
  ticketTtlMs: 120_000,
  maxTickets: 4,
  maxCredentials: 16,
  credentialIdleMs: 43_200_000,
  credentialMaxAgeMs: 86_400_000,
  failureWindowMs: 60_000,
  maxFailures: 8,
  touchIntervalMs: 60_000,
};

/** What `mint` returns (the lifecycle's `AccessMinter` result: the control op `access` turns it into its reply). */
export interface AccessMint {
  readonly code: string;
  readonly expiresAtMs: number;
  readonly ttlSeconds: number;
}

/** A live credential as `verify` reports it. `expiresAtMs` is the earlier of the idle and the absolute limit. */
export interface AccessSession {
  readonly credentialId: string;
  readonly expiresAtMs: number;
}

export type ExchangeOutcome =
  | {
      readonly ok: true;
      /** The value for the cookie; shown once, never kept. */
      readonly credential: string;
      /** A name for the credential that is safe to hold in a socket table; it is no secret and opens nothing. */
      readonly credentialId: string;
      /** When the credential ends at the latest (sign-in plus the absolute lifetime), for the cookie `Max-Age`. */
      readonly expiresAtMs: number;
    }
  | { readonly ok: false; readonly reason: 'invalid' }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterMs: number };

export interface AccessService {
  /** A new one-use access code for the login link. */
  mint(): AccessMint;
  /** Redeems a code for a credential. Never throws; a code of any type is judged, not trusted. */
  exchange(code: string): ExchangeOutcome;
  /** The live credential for a cookie value (touching its idle clock at most once a minute), or `null`. */
  verify(credential: string | undefined): AccessSession | null;
  /** True when `header` is `Bearer <control token>`. */
  verifyBearer(header: string | undefined): boolean;
  /** Ends a credential and tells the listeners; an unknown id is ignored. */
  revoke(credentialId: string): void;
  /** `listener(credentialId)` runs when a credential is revoked, dropped at the cap or expires. Returns the way to stop listening. */
  onRevoked(listener: (credentialId: string) => void): () => void;
}

export interface AccessServiceOptions {
  readonly clock: Clock;
  readonly limits?: Partial<AccessLimits>;
  /** Tests only: the source of random bytes (default `crypto.randomBytes`). */
  readonly random?: (bytes: number) => Buffer;
  /**
   * The control token (`run/control.token`) that `verifyBearer` accepts: a value, or a function that is read on every call (the
   * token of a boot that has not written it yet is `null`). Without one, `verifyBearer` always answers false.
   */
  readonly controlToken?: string | null | (() => string | null);
}

const SECRET_BYTES = 32;
const ID_BYTES = 9;
/** The shape of a credential (a cookie value): 32 random bytes in base64url. A code is not a credential, and the reverse. */
const CREDENTIAL_RE = /^[A-Za-z0-9_-]{43}$/;
/** `Authorization: Bearer <token68>`: one space, no list, no parameters. */
const BEARER_RE = /^bearer ([A-Za-z0-9._~+/-]+=*)$/i;
/** A header longer than this is not a Bearer value of ours (the control token is 64 characters). */
const BEARER_MAX_CHARS = 512;

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`createAccessService: ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function resolveLimits(given: Partial<AccessLimits> | undefined): AccessLimits {
  const merged: AccessLimits = { ...ACCESS_LIMITS, ...given };
  // every field is named here; a test tries each key of ACCESS_LIMITS, so a limit added without a check here is noticed
  positiveInteger('ticketTtlMs', merged.ticketTtlMs);
  positiveInteger('maxTickets', merged.maxTickets);
  positiveInteger('maxCredentials', merged.maxCredentials);
  positiveInteger('credentialIdleMs', merged.credentialIdleMs);
  positiveInteger('credentialMaxAgeMs', merged.credentialMaxAgeMs);
  positiveInteger('failureWindowMs', merged.failureWindowMs);
  positiveInteger('maxFailures', merged.maxFailures);
  positiveInteger('touchIntervalMs', merged.touchIntervalMs);
  return merged;
}

interface Ticket {
  readonly hash: Buffer;
  readonly expiresAtMs: number;
}

interface Credential {
  readonly id: string;
  readonly hash: Buffer;
  readonly createdAtMs: number;
  touchedAtMs: number;
}

export function createAccessService(options: AccessServiceOptions): AccessService {
  const { clock } = options;
  const limits = resolveLimits(options.limits);
  const random = options.random ?? randomBytes;
  const controlToken = options.controlToken ?? null;

  /** Oldest first. */
  let tickets: Ticket[] = [];
  /** By the hex of the hash; insertion order is sign-in order, so the first entry is the oldest. */
  const credentials = new Map<string, Credential>();
  /** Times of the wrong codes inside the window, oldest first. */
  const failures: number[] = [];
  const listeners = new Set<(credentialId: string) => void>();

  function sweepTickets(now: number): void {
    tickets = tickets.filter((ticket) => now < ticket.expiresAtMs);
  }

  function expiryOf(credential: Credential): number {
    return Math.min(
      credential.createdAtMs + limits.credentialMaxAgeMs,
      credential.touchedAtMs + limits.credentialIdleMs,
    );
  }

  /** Removes a credential and tells the listeners. A listener that throws must not keep the others from hearing it. */
  function drop(key: string, credential: Credential): void {
    if (!credentials.delete(key)) return;
    for (const listener of [...listeners]) {
      try {
        listener(credential.id);
      } catch {
        // the listener belongs to a socket or a stream that is already gone; the credential is revoked either way
      }
    }
  }

  function sweepCredentials(now: number): void {
    for (const [key, credential] of [...credentials]) {
      if (now >= expiryOf(credential)) drop(key, credential);
    }
  }

  function mint(): AccessMint {
    const now = clock.now();
    sweepTickets(now);
    while (tickets.length >= limits.maxTickets) tickets.shift();
    const code = random(SECRET_BYTES).toString('base64url');
    const expiresAtMs = now + limits.ticketTtlMs;
    tickets.push({ hash: sha256(code), expiresAtMs });
    return { code, expiresAtMs, ttlSeconds: Math.round(limits.ticketTtlMs / 1000) };
  }

  /** Compares the hash of `code` with every outstanding ticket, with no early exit; the index of the match or -1. */
  function matchTicket(code: unknown): number {
    if (typeof code !== 'string' || !ACCESS_CODE_RE.test(code)) return -1;
    const candidate = sha256(code);
    let found = -1;
    tickets.forEach((ticket, index) => {
      if (timingSafeEqual(candidate, ticket.hash)) found = index;
    });
    return found;
  }

  function exchange(code: string): ExchangeOutcome {
    const now = clock.now();
    sweepTickets(now);
    sweepCredentials(now);
    const index = matchTicket(code);
    if (index >= 0) {
      // a valid code redeems even while the limiter is tripped (A3); the ticket is gone before anything else can use it
      tickets.splice(index, 1);
      const credential = random(SECRET_BYTES).toString('base64url');
      const id = random(ID_BYTES).toString('base64url');
      while (credentials.size >= limits.maxCredentials) {
        const oldest = credentials.entries().next();
        if (oldest.done === true) break;
        drop(oldest.value[0], oldest.value[1]);
      }
      const hash = sha256(credential);
      credentials.set(hash.toString('hex'), { id, hash, createdAtMs: now, touchedAtMs: now });
      return { ok: true, credential, credentialId: id, expiresAtMs: now + limits.credentialMaxAgeMs };
    }
    while (failures.length > 0 && (failures[0] ?? now) + limits.failureWindowMs <= now) failures.shift();
    if (failures.length >= limits.maxFailures) {
      const oldest = failures[0] ?? now;
      return { ok: false, reason: 'rate_limited', retryAfterMs: Math.max(1, oldest + limits.failureWindowMs - now) };
    }
    failures.push(now);
    return { ok: false, reason: 'invalid' };
  }

  function verify(value: string | undefined): AccessSession | null {
    const now = clock.now();
    sweepCredentials(now);
    if (typeof value !== 'string' || !CREDENTIAL_RE.test(value)) return null;
    const candidate = sha256(value);
    const credential = credentials.get(candidate.toString('hex'));
    if (credential === undefined || !timingSafeEqual(candidate, credential.hash)) return null;
    if (now - credential.touchedAtMs >= limits.touchIntervalMs) credential.touchedAtMs = now;
    return { credentialId: credential.id, expiresAtMs: expiryOf(credential) };
  }

  function verifyBearer(header: string | undefined): boolean {
    if (typeof header !== 'string' || header.length > BEARER_MAX_CHARS) return false;
    const token = typeof controlToken === 'function' ? controlToken() : controlToken;
    if (token === null || token === '') return false;
    const given = BEARER_RE.exec(header)?.[1];
    if (given === undefined) return false;
    return timingSafeEqual(sha256(given), sha256(token));
  }

  function revoke(credentialId: string): void {
    for (const [key, credential] of credentials) {
      if (credential.id === credentialId) {
        drop(key, credential);
        return;
      }
    }
  }

  function onRevoked(listener: (credentialId: string) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { mint, exchange, verify, verifyBearer, revoke, onRevoked };
}
