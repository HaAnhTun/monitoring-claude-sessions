// `createAccessService` (CAW design 02 4.2, amendments A1 to A3, ADR 0084): single-use tickets of 120 s, session credentials with an
// idle and an absolute lifetime, a limiter that bounds noise but never locks the owner out, the control token as a Bearer value,
// revocation with listeners, and hashes only. Time is a FakeClock and the random source is injected, so nothing here waits.
import type * as NodeCrypto from 'node:crypto';
import { inspect } from 'node:util';

import { ACCESS_CODE_RE, ACCESS_CODE_TTL_SECONDS } from '@mcs/shared/protocol';
import { FakeClock } from '@mcs/testkit';
import { describe, expect, it, vi } from 'vitest';

import {
  ACCESS_LIMITS,
  createAccessService,
  type AccessService,
  type AccessServiceOptions,
  type ExchangeOutcome,
} from './access-service.ts';

// Count the constant-time comparisons: the exchange must compare against every outstanding ticket, with no early exit.
const compares = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      compares.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const START = Date.UTC(2026, 0, 1);
/** A letter outside the base64url alphabet, built from its code point so that this file stays ASCII. */
const E_ACUTE = String.fromCharCode(0xe9);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
// FIXTURE: invented data for tests
const CONTROL_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_TOKEN = '0f0e0d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100';

/** A deterministic source of "random" bytes: every call returns the next counter value spread over the requested length. */
function sequence(): { random: (bytes: number) => Buffer; asked: number[] } {
  let next = 1;
  const asked: number[] = [];
  return {
    asked,
    random: (bytes) => {
      asked.push(bytes);
      const out = Buffer.alloc(bytes);
      for (let i = 0; i < bytes; i += 1) out[i] = (next * 31 + i * 7) % 256;
      out.writeUInt32BE(next, 0);
      next += 1;
      return out;
    },
  };
}

interface Harness {
  readonly clock: FakeClock;
  readonly service: AccessService;
  readonly asked: number[];
}

function make(options: Partial<Omit<AccessServiceOptions, 'clock'>> = {}): Harness {
  const clock = new FakeClock(START);
  const { random, asked } = sequence();
  const service = createAccessService({ clock, random, ...options });
  return { clock, service, asked };
}

function redeemed(outcome: ExchangeOutcome): Extract<ExchangeOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected a redeemed ticket, got ${outcome.reason}`);
  return outcome;
}

function invalidCode(seed: number): string {
  return `${String(seed).padStart(3, '0')}${'x'.repeat(40)}`;
}

describe('ACCESS_LIMITS (design 02 4.2, A2)', () => {
  it('holds the documented numbers, and the ticket lifetime is the shared one', () => {
    expect(ACCESS_LIMITS).toEqual({
      ticketTtlMs: 120_000,
      maxTickets: 4,
      maxCredentials: 16,
      credentialIdleMs: 12 * HOUR,
      credentialMaxAgeMs: 24 * HOUR,
      failureWindowMs: 60_000,
      maxFailures: 8,
      touchIntervalMs: 60_000,
    });
    expect(ACCESS_LIMITS.ticketTtlMs).toBe(ACCESS_CODE_TTL_SECONDS * 1000);
  });

  it('refuses a limit that is not a positive integer, for every limit there is', () => {
    for (const key of Object.keys(ACCESS_LIMITS)) {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const limits = { [key]: bad };
        expect(() => createAccessService({ clock: new FakeClock(START), limits }), `${key}=${String(bad)}`).toThrow(
          RangeError,
        );
      }
    }
  });
});

describe('mint (TC-SEC-01)', () => {
  it('returns a 43 character code of 32 random bytes that lives 120 seconds', () => {
    const { service, asked } = make();
    const minted = service.mint();
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ACCESS_CODE_RE.test(minted.code)).toBe(true);
    expect(minted.ttlSeconds).toBe(120);
    expect(minted.expiresAtMs).toBe(START + 120_000);
    expect(asked).toEqual([32]);
  });

  it('gives every ticket another code', () => {
    const { service } = make();
    expect(new Set([service.mint().code, service.mint().code, service.mint().code]).size).toBe(3);
  });

  it('works with the system random source when none is given', () => {
    const service = createAccessService({ clock: new FakeClock(START) });
    const { code } = service.mint();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.exchange(code).ok).toBe(true);
  });
});

describe('exchange: tickets (TC-SEC-01, TC-SEC-05)', () => {
  it('turns a ticket into a credential that is not the code, and the credential verifies', () => {
    const { service, clock, asked } = make();
    const { code } = service.mint();
    const outcome = redeemed(service.exchange(code));
    expect(outcome.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(outcome.credential).not.toBe(code);
    expect(outcome.credentialId.length).toBeGreaterThan(0);
    expect(outcome.credentialId).not.toBe(outcome.credential);
    expect(outcome.expiresAtMs).toBe(clock.now() + 24 * HOUR);
    expect(asked).toEqual([32, 32, 9]);
    // the idle limit (12 h) is the earlier one right after sign-in
    expect(service.verify(outcome.credential)).toEqual({
      credentialId: outcome.credentialId,
      expiresAtMs: clock.now() + 12 * HOUR,
    });
  });

  it('redeems a ticket once: the second use of the same code is invalid', () => {
    const { service } = make();
    const { code } = service.mint();
    expect(service.exchange(code).ok).toBe(true);
    expect(service.exchange(code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps the credential of a redeemed ticket when the code is tried again', () => {
    const { service } = make();
    const { code } = service.mint();
    const first = redeemed(service.exchange(code));
    service.exchange(code);
    expect(service.verify(first.credential)).not.toBeNull();
  });

  it('expires a ticket after exactly 120 seconds', () => {
    const { service, clock } = make();
    const early = service.mint();
    clock.advance(120_000 - 1);
    expect(service.exchange(early.code).ok).toBe(true);
    const late = service.mint();
    clock.advance(120_000);
    expect(service.exchange(late.code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('drops the oldest ticket when more than four are outstanding', () => {
    const { service } = make();
    const codes = Array.from({ length: 5 }, () => service.mint().code);
    expect(service.exchange(codes[0] ?? '')).toEqual({ ok: false, reason: 'invalid' });
    for (const code of codes.slice(1)) expect(service.exchange(code).ok).toBe(true);
  });

  it('does not count an expired ticket against the cap', () => {
    const { service, clock } = make();
    const old = Array.from({ length: 4 }, () => service.mint().code);
    clock.advance(120_000);
    const fresh = Array.from({ length: 4 }, () => service.mint().code);
    for (const code of fresh) expect(service.exchange(code).ok).toBe(true);
    for (const code of old) expect(service.exchange(code).ok).toBe(false);
  });

  it('rejects a code that was never minted and codes that are not codes', () => {
    const refused: unknown[] = [
      invalidCode(1),
      '',
      'short',
      'a'.repeat(31),
      'a'.repeat(129),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)} `,
      `${'a'.repeat(42)}\n`,
      `${'a'.repeat(42)}${E_ACUTE}`,
      undefined,
      null,
      42,
      { code: 'x' },
    ];
    for (const code of refused) {
      const { service } = make(); // one service each: the limiter would trip after eight refusals
      service.mint();
      expect(service.exchange(code as string), String(code)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('never takes a credential for a code, or a ticket for a credential (TC-SEC-08)', () => {
    const { service } = make();
    const { code } = service.mint();
    const outcome = redeemed(service.exchange(code));
    expect(service.exchange(outcome.credential)).toEqual({ ok: false, reason: 'invalid' });
    expect(service.verify(code)).toBeNull();
    const second = service.mint().code;
    expect(service.verify(second)).toBeNull();
  });

  it('compares against every outstanding ticket and does not stop at the first match', () => {
    const { service } = make();
    const codes = Array.from({ length: 4 }, () => service.mint().code);
    compares.calls = 0;
    expect(service.exchange(codes[0] ?? '').ok).toBe(true);
    expect(compares.calls).toBe(4);
    compares.calls = 0;
    expect(service.exchange(invalidCode(9)).ok).toBe(false);
    expect(compares.calls).toBe(3);
  });
});

describe('exchange: the failure limiter (TC-SEC-04, A3)', () => {
  it('answers invalid for eight wrong codes, then rate_limited with the wait', () => {
    const { service, clock } = make();
    for (let i = 0; i < 8; i += 1) {
      expect(service.exchange(invalidCode(i)), `failure ${String(i)}`).toEqual({ ok: false, reason: 'invalid' });
      clock.advance(SECOND);
    }
    // the first failure happened 8 s ago: it leaves the window in 52 s
    expect(service.exchange(invalidCode(100))).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterMs: 52 * SECOND,
    });
    clock.advance(10 * SECOND);
    expect(service.exchange(invalidCode(101))).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterMs: 42 * SECOND,
    });
  });

  it('still redeems a valid code while the limiter is tripped (the owner is never locked out)', () => {
    const { service } = make();
    for (let i = 0; i < 12; i += 1) service.exchange(invalidCode(i));
    expect(service.exchange(invalidCode(50)).ok).toBe(false);
    const { code } = service.mint();
    const outcome = service.exchange(code);
    expect(outcome.ok).toBe(true);
    // and the very next wrong code is still limited
    expect(service.exchange(invalidCode(51))).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('counts malformed codes like wrong ones', () => {
    const { service } = make();
    for (let i = 0; i < 8; i += 1) service.exchange('not a code');
    expect(service.exchange('still not a code')).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('recovers when the oldest failure leaves the 60 second window', () => {
    const { service, clock } = make();
    for (let i = 0; i < 8; i += 1) service.exchange(invalidCode(i));
    expect(service.exchange(invalidCode(60))).toMatchObject({ reason: 'rate_limited', retryAfterMs: 60 * SECOND });
    clock.advance(60 * SECOND - 1);
    expect(service.exchange(invalidCode(61))).toMatchObject({ reason: 'rate_limited', retryAfterMs: 1 });
    clock.advance(1);
    expect(service.exchange(invalidCode(62))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('slides: failures spread over time never trip the limiter', () => {
    const { service, clock } = make();
    for (let i = 0; i < 40; i += 1) {
      expect(service.exchange(invalidCode(i)), `failure ${String(i)}`).toEqual({ ok: false, reason: 'invalid' });
      clock.advance(8 * SECOND);
    }
  });

  it('does not count the codes it refused while limited, so the wait never grows', () => {
    const { service, clock } = make();
    for (let i = 0; i < 8; i += 1) service.exchange(invalidCode(i));
    for (let i = 0; i < 20; i += 1) service.exchange(invalidCode(200 + i));
    clock.advance(60 * SECOND);
    expect(service.exchange(invalidCode(300))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('does not count a redeemed ticket as a failure', () => {
    const { service } = make();
    for (let i = 0; i < 20; i += 1) expect(service.exchange(service.mint().code).ok).toBe(true);
    expect(service.exchange(invalidCode(1))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('takes the limits from the options', () => {
    const { service, clock } = make({ limits: { maxFailures: 2, failureWindowMs: 5000 } });
    service.exchange(invalidCode(1));
    service.exchange(invalidCode(2));
    expect(service.exchange(invalidCode(3))).toEqual({ ok: false, reason: 'rate_limited', retryAfterMs: 5000 });
    clock.advance(5000);
    expect(service.exchange(invalidCode(4))).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('verify: idle and absolute lifetime (A2)', () => {
  function signedIn(h: Harness): string {
    return redeemed(h.service.exchange(h.service.mint().code)).credential;
  }

  it('rejects a missing, malformed or unknown credential', () => {
    const h = make();
    signedIn(h);
    for (const value of [undefined, '', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`, invalidCode(1), null, 7]) {
      expect(h.service.verify(value as string | undefined), String(value)).toBeNull();
    }
  });

  it('expires after 12 hours without use, to the millisecond', () => {
    const h = make();
    const used = signedIn(h);
    const idle = signedIn(h);
    h.clock.advance(12 * HOUR - 1);
    expect(h.service.verify(used)).not.toBeNull(); // this use moves the idle limit of `used` only
    h.clock.advance(1);
    expect(h.service.verify(idle)).toBeNull();
    expect(h.service.verify(used)).not.toBeNull();
  });

  it('expires after 24 hours whatever the use, to the millisecond', () => {
    const h = make();
    const credential = signedIn(h);
    for (let hours = 1; hours <= 23; hours += 1) {
      h.clock.advance(HOUR);
      expect(h.service.verify(credential), `after ${String(hours)} h`).not.toBeNull();
    }
    h.clock.advance(HOUR - 1);
    expect(h.service.verify(credential)).not.toBeNull();
    h.clock.advance(1);
    expect(h.service.verify(credential)).toBeNull();
  });

  it('touches the idle clock at most once a minute', () => {
    const h = make();
    const credential = signedIn(h);
    // 59 s after sign-in: no touch, the idle clock still reads the sign-in time
    h.clock.advance(59 * SECOND);
    expect(h.service.verify(credential)).not.toBeNull();
    h.clock.advance(12 * HOUR - 59 * SECOND);
    expect(h.service.verify(credential)).toBeNull();

    // a use after 60 s does touch it: the idle limit moves to 60 s + 12 h, so sign-in + 12 h is still alive
    const touched = signedIn(h);
    h.clock.advance(60 * SECOND);
    expect(h.service.verify(touched)).not.toBeNull();
    h.clock.advance(12 * HOUR - 60 * SECOND);
    expect(h.service.verify(touched)).not.toBeNull();
  });

  it('reports the earlier of the two expiry times', () => {
    const h = make();
    const credential = signedIn(h);
    expect(h.service.verify(credential)?.expiresAtMs).toBe(START + 12 * HOUR);
    h.clock.advance(11 * HOUR);
    expect(h.service.verify(credential)?.expiresAtMs).toBe(START + 23 * HOUR);
    h.clock.advance(11 * HOUR);
    expect(h.service.verify(credential)?.expiresAtMs).toBe(START + 24 * HOUR);
  });

  it('takes the lifetimes from the options', () => {
    const h = make({ limits: { credentialIdleMs: 1000, credentialMaxAgeMs: 5000, touchIntervalMs: 100 } });
    const credential = signedIn(h);
    h.clock.advance(999);
    expect(h.service.verify(credential)).not.toBeNull();
    h.clock.advance(1000);
    expect(h.service.verify(credential)).toBeNull();
  });
});

describe('credentials: cap, revoke and listeners', () => {
  it('revokes the oldest credential when more than sixteen are live, and tells the listeners', () => {
    const h = make();
    const revoked: string[] = [];
    h.service.onRevoked((id) => revoked.push(id));
    const outcomes = Array.from({ length: 17 }, () => redeemed(h.service.exchange(h.service.mint().code)));
    expect(h.service.verify(outcomes[0]?.credential)).toBeNull();
    for (const outcome of outcomes.slice(1)) expect(h.service.verify(outcome.credential)).not.toBeNull();
    expect(revoked).toEqual([outcomes[0]?.credentialId]);
  });

  it('revoke ends the credential and calls every listener once with its id', () => {
    const h = make();
    const a: string[] = [];
    const b: string[] = [];
    h.service.onRevoked((id) => a.push(id));
    h.service.onRevoked((id) => b.push(id));
    const first = redeemed(h.service.exchange(h.service.mint().code));
    const second = redeemed(h.service.exchange(h.service.mint().code));
    h.service.revoke(first.credentialId);
    expect(h.service.verify(first.credential)).toBeNull();
    expect(h.service.verify(second.credential)).not.toBeNull();
    expect(a).toEqual([first.credentialId]);
    expect(b).toEqual([first.credentialId]);
    h.service.revoke(first.credentialId);
    expect(a).toEqual([first.credentialId]);
  });

  it('ignores the id of a credential that does not exist', () => {
    const h = make();
    const seen: string[] = [];
    h.service.onRevoked((id) => seen.push(id));
    h.service.revoke('unknown');
    h.service.revoke('');
    expect(seen).toEqual([]);
  });

  it('stops calling a listener that was removed', () => {
    const h = make();
    const seen: string[] = [];
    const off = h.service.onRevoked((id) => seen.push(id));
    off();
    off();
    const outcome = redeemed(h.service.exchange(h.service.mint().code));
    h.service.revoke(outcome.credentialId);
    expect(seen).toEqual([]);
  });

  it('keeps revoking when a listener throws, and reaches the listeners after it', () => {
    const h = make();
    const seen: string[] = [];
    h.service.onRevoked(() => {
      throw new Error('a socket that is already gone');
    });
    h.service.onRevoked((id) => seen.push(id));
    const outcome = redeemed(h.service.exchange(h.service.mint().code));
    h.service.revoke(outcome.credentialId);
    expect(h.service.verify(outcome.credential)).toBeNull();
    expect(seen).toEqual([outcome.credentialId]);
  });

  it('tells the listeners when a credential expires, so that a socket can close', () => {
    const h = make();
    const seen: string[] = [];
    h.service.onRevoked((id) => seen.push(id));
    const outcome = redeemed(h.service.exchange(h.service.mint().code));
    h.clock.advance(12 * HOUR);
    expect(h.service.verify(outcome.credential)).toBeNull();
    expect(seen).toEqual([outcome.credentialId]);
    expect(h.service.verify(outcome.credential)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it('sweeps expired credentials when somebody signs in, so the cap counts live ones only', () => {
    const h = make({ limits: { maxCredentials: 2 } });
    const seen: string[] = [];
    h.service.onRevoked((id) => seen.push(id));
    const old = [
      redeemed(h.service.exchange(h.service.mint().code)),
      redeemed(h.service.exchange(h.service.mint().code)),
    ];
    h.clock.advance(12 * HOUR);
    const fresh = redeemed(h.service.exchange(h.service.mint().code));
    expect(h.service.verify(fresh.credential)).not.toBeNull();
    expect(seen.sort()).toEqual(old.map((o) => o.credentialId).sort());
  });
});

describe('verifyBearer: the control token on a reader route (A1)', () => {
  it('accepts exactly the control token, with the scheme in any case', () => {
    const { service } = make({ controlToken: CONTROL_TOKEN });
    expect(service.verifyBearer(`Bearer ${CONTROL_TOKEN}`)).toBe(true);
    expect(service.verifyBearer(`bearer ${CONTROL_TOKEN}`)).toBe(true);
    expect(service.verifyBearer(`BEARER ${CONTROL_TOKEN}`)).toBe(true);
  });

  it('refuses another token, a prefix, a longer value and every other shape', () => {
    const { service } = make({ controlToken: CONTROL_TOKEN });
    const refused: (string | undefined)[] = [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      `Bearer ${OTHER_TOKEN}`,
      `Bearer ${CONTROL_TOKEN.slice(0, 63)}`,
      `Bearer ${CONTROL_TOKEN}0`,
      `Bearer  ${CONTROL_TOKEN}`,
      `Bearer ${CONTROL_TOKEN} `,
      `Bearer ${CONTROL_TOKEN}\n`,
      `Basic ${CONTROL_TOKEN}`,
      `Token ${CONTROL_TOKEN}`,
      CONTROL_TOKEN,
      `Bearer ${CONTROL_TOKEN.toUpperCase()}`,
      `Bearer ${'a'.repeat(100_000)}`,
      `Bearer ${CONTROL_TOKEN}, Bearer ${OTHER_TOKEN}`,
    ];
    for (const header of refused) expect(service.verifyBearer(header), String(header).slice(0, 80)).toBe(false);
  });

  it('refuses everything when the service has no control token', () => {
    for (const controlToken of [undefined, null, () => null]) {
      const options = controlToken === undefined ? {} : { controlToken };
      const { service } = make(options);
      expect(service.verifyBearer(`Bearer ${CONTROL_TOKEN}`)).toBe(false);
      expect(service.verifyBearer('Bearer ')).toBe(false);
    }
  });

  it('reads the token again on every call when it is a function', () => {
    let token: string | null = CONTROL_TOKEN;
    const { service } = make({ controlToken: () => token });
    expect(service.verifyBearer(`Bearer ${CONTROL_TOKEN}`)).toBe(true);
    token = OTHER_TOKEN;
    expect(service.verifyBearer(`Bearer ${CONTROL_TOKEN}`)).toBe(false);
    expect(service.verifyBearer(`Bearer ${OTHER_TOKEN}`)).toBe(true);
    token = null;
    expect(service.verifyBearer(`Bearer ${OTHER_TOKEN}`)).toBe(false);
  });

  it('does not take a session credential or a ticket for the control token, and the token is no credential', () => {
    const { service } = make({ controlToken: CONTROL_TOKEN });
    const { code } = service.mint();
    const outcome = redeemed(service.exchange(code));
    expect(service.verifyBearer(`Bearer ${outcome.credential}`)).toBe(false);
    expect(service.verifyBearer(`Bearer ${code}`)).toBe(false);
    expect(service.verify(CONTROL_TOKEN)).toBeNull();
    expect(service.exchange(CONTROL_TOKEN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('compares one hash against one hash in constant time', () => {
    const { service } = make({ controlToken: CONTROL_TOKEN });
    compares.calls = 0;
    expect(service.verifyBearer(`Bearer ${CONTROL_TOKEN}`)).toBe(true);
    expect(compares.calls).toBe(1);
  });
});

describe('what the service keeps (TC-SEC-01, hashes only)', () => {
  it('shows no ticket, credential or token in a dump of the service', () => {
    const { service } = make({ controlToken: CONTROL_TOKEN });
    const { code } = service.mint();
    const pending = service.mint().code;
    const outcome = redeemed(service.exchange(code));
    const dumps = [
      JSON.stringify(service),
      inspect(service, { showHidden: true, depth: 8 }),
      Object.prototype.toString.call(service),
      Object.keys(service).join(','),
    ];
    for (const dump of dumps) {
      for (const secret of [code, pending, outcome.credential, CONTROL_TOKEN]) {
        expect(dump.includes(secret)).toBe(false);
      }
    }
    expect(Object.keys(service).sort()).toEqual(
      ['exchange', 'mint', 'onRevoked', 'revoke', 'verify', 'verifyBearer'].sort(),
    );
  });
});
