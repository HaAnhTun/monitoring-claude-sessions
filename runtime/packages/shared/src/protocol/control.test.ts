// The control protocol parsers (01 4.3, ADR 0005): the reply codes are a closed list, and `INTERNAL` is one of them.
import { describe, expect, it } from 'vitest';

import { ACCESS_CODE_RE } from './access.ts';
import {
  CONTROL_ERROR_CODES,
  CONTROL_OPS,
  CONTROL_REQUEST_MAX_BYTES,
  controlTimeoutMs,
  parseControlRequest,
  parseControlResponse,
  type ControlErrorCode,
} from './control.ts';

const ID = 'abcdef01-abcd-4bcd-8bcd-abcdef012345';
const TOKEN = 'ab'.repeat(32);
const CODE = 'Xy9_-'.repeat(8);
const NOW = '2026-11-14T10:00:00.000Z';

describe('ControlErrorCode', () => {
  it('is the closed list, with INTERNAL for a service that threw', () => {
    expect([...CONTROL_ERROR_CODES]).toEqual([
      'BAD_REQUEST',
      'FORBIDDEN',
      'INSTANCE_MISMATCH',
      'NOT_READY',
      'BACKUP_FAILED',
      'INTERNAL',
      'TERMINALS_LIVE',
      'UNSUPPORTED',
    ]);
  });

  it('round-trips every code through parseControlResponse', () => {
    for (const error of CONTROL_ERROR_CODES) {
      const code: ControlErrorCode = error;
      expect(parseControlResponse(JSON.stringify({ v: 1, ok: false, error: code }))).toEqual({
        v: 1,
        ok: false,
        error: code,
      });
    }
  });

  it('refuses a code outside the list, a reply with extra keys and a reply without a code', () => {
    expect(parseControlResponse('{"v":1,"ok":false,"error":"EXPLODED"}')).toBeNull();
    expect(parseControlResponse('{"v":1,"ok":false,"error":"internal"}')).toBeNull();
    expect(parseControlResponse('{"v":1,"ok":false,"error":"INTERNAL","message":"boom"}')).toBeNull();
    expect(parseControlResponse('{"v":1,"ok":false}')).toBeNull();
    expect(parseControlResponse('{"v":2,"ok":false,"error":"INTERNAL"}')).toBeNull();
  });
});

describe('parseControlRequest', () => {
  it('reads the four operations and refuses everything else', () => {
    expect(parseControlRequest('{"v":1,"op":"identify"}')).toEqual({ v: 1, op: 'identify' });
    expect(
      parseControlRequest(JSON.stringify({ v: 1, op: 'shutdown', instanceId: ID, token: TOKEN, reason: 'stop' })),
    ).toMatchObject({ op: 'shutdown', reason: 'stop' });
    expect(parseControlRequest('{"v":1,"op":"identify","extra":1}')).toBeNull();
    expect(parseControlRequest('{"v":1,"op":"explode"}')).toBeNull();
    expect(parseControlRequest('not json')).toBeNull();
  });

  it('refuses a line over the byte limit, counted in UTF-8 bytes', () => {
    const base = JSON.stringify({ v: 1, op: 'backup', instanceId: ID, token: TOKEN, dest: '' });
    const room = CONTROL_REQUEST_MAX_BYTES - base.length;
    const fits = JSON.stringify({ v: 1, op: 'backup', instanceId: ID, token: TOKEN, dest: 'a'.repeat(room) });
    expect(parseControlRequest(fits)).not.toBeNull();
    const wide = JSON.stringify({
      v: 1,
      op: 'backup',
      instanceId: ID,
      token: TOKEN,
      dest: String.fromCharCode(0xe9).repeat(room),
    });
    expect(parseControlRequest(wide)).toBeNull();
  });
});

describe('the user instance operations (06 1.8)', () => {
  const base = { v: 1, instanceId: ID, token: TOKEN };
  const line = (o: Record<string, unknown>): string => JSON.stringify(o);

  it('lists terminals and access among the operations', () => {
    expect([...CONTROL_OPS]).toEqual(['identify', 'shutdown', 'backup', 'ingest-replay', 'terminals', 'access']);
    expect(controlTimeoutMs('terminals')).toBe(2000);
    expect(controlTimeoutMs('access')).toBe(2000);
  });

  it('reads terminals and access with exactly the four keys', () => {
    expect(parseControlRequest(line({ ...base, op: 'terminals' }))).toEqual({ ...base, op: 'terminals' });
    expect(parseControlRequest(line({ ...base, op: 'access' }))).toEqual({ ...base, op: 'access' });
  });

  it('refuses terminals and access without an instance id or token, with an empty one, or with an extra key', () => {
    for (const op of ['terminals', 'access']) {
      expect(parseControlRequest(line({ v: 1, op })), op).toBeNull();
      expect(parseControlRequest(line({ v: 1, op, instanceId: ID })), op).toBeNull();
      expect(parseControlRequest(line({ v: 1, op, token: TOKEN })), op).toBeNull();
      expect(parseControlRequest(line({ ...base, op, instanceId: '' })), op).toBeNull();
      expect(parseControlRequest(line({ ...base, op, token: '' })), op).toBeNull();
      expect(parseControlRequest(line({ ...base, op, instanceId: 5 })), op).toBeNull();
      expect(parseControlRequest(line({ ...base, op, force: true })), op).toBeNull();
      expect(parseControlRequest(line({ ...base, op, extra: 1 })), op).toBeNull();
      expect(parseControlRequest(line({ ...base, op, v: 2 })), op).toBeNull();
    }
  });

  it('reads shutdown with the five keys, or with force true added', () => {
    const plain = { ...base, op: 'shutdown', reason: 'stop' };
    expect(parseControlRequest(line(plain))).toEqual(plain);
    expect(parseControlRequest(line({ ...plain, force: true }))).toEqual({ ...plain, force: true });
    for (const reason of ['stop', 'restart', 'upgrade', 'signal']) {
      expect(parseControlRequest(line({ ...plain, reason, force: true }))).toMatchObject({ reason, force: true });
    }
  });

  it('refuses force that is not exactly true, and keys beyond force', () => {
    const plain = { ...base, op: 'shutdown', reason: 'stop' };
    for (const force of [false, 'true', 1, 0, null, [], {}]) {
      expect(parseControlRequest(line({ ...plain, force })), JSON.stringify(force)).toBeNull();
    }
    expect(parseControlRequest(line({ ...plain, force: true, extra: 1 }))).toBeNull();
    expect(parseControlRequest(line({ ...plain, reason: 'explode', force: true }))).toBeNull();
    expect(parseControlRequest(line({ ...base, op: 'backup', dest: 'x', force: true }))).toBeNull();
  });

  it('keeps the 4096 byte cap for the new requests', () => {
    const request = line({ ...base, op: 'terminals' });
    expect(parseControlRequest(request)).not.toBeNull();
    expect(
      parseControlRequest(request.slice(0, -1) + ',"pad":"' + 'a'.repeat(CONTROL_REQUEST_MAX_BYTES) + '"}'),
    ).toBeNull();
    expect(parseControlRequest(line({ ...base, op: 'access', pad: 'a'.repeat(CONTROL_REQUEST_MAX_BYTES) }))).toBeNull();
  });

  it('refuses a request line that carries a newline', () => {
    expect(parseControlRequest(line({ ...base, op: 'access' }) + String.fromCharCode(10) + '{}')).toBeNull();
  });

  describe('terminals reply', () => {
    const sessions = [
      { name: 'api-1', startedAt: NOW },
      { name: 'web', startedAt: '2026-11-14T10:05:00.000Z' },
    ];
    const reply = { v: 1, ok: true, op: 'terminals', live: 2, max: 8, sessions };

    it('round-trips', () => {
      expect(parseControlResponse(line(reply))).toEqual(reply);
      expect(parseControlResponse(line({ ...reply, live: 0, sessions: [] }))).toMatchObject({ live: 0, sessions: [] });
    });

    it('takes at most 50 sessions', () => {
      const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: 's' + String(i), startedAt: NOW }));
      expect(parseControlResponse(line({ ...reply, live: 50, sessions: many(50) }))).not.toBeNull();
      expect(parseControlResponse(line({ ...reply, live: 51, sessions: many(51) }))).toBeNull();
    });

    it('refuses wrong shapes', () => {
      const bad: Record<string, unknown>[] = [
        { ...reply, live: -1 },
        { ...reply, live: 1.5 },
        { ...reply, live: '2' },
        { ...reply, max: -1 },
        { ...reply, max: null },
        { ...reply, sessions: null },
        { ...reply, sessions: 'x' },
        { ...reply, sessions: [{ name: '', startedAt: NOW }] },
        { ...reply, sessions: [{ name: 'a' }] },
        { ...reply, sessions: [{ startedAt: NOW }] },
        { ...reply, sessions: [{ name: 'a', startedAt: 5 }] },
        { ...reply, sessions: [{ name: 'a', startedAt: NOW, extra: 1 }] },
        { ...reply, sessions: [null] },
        { ...reply, sessions: ['a'] },
        { ...reply, extra: 1 },
        { v: 1, ok: true, op: 'terminals', live: 2, max: 8 },
      ];
      for (const r of bad) expect(parseControlResponse(line(r)), line(r)).toBeNull();
    });
  });

  describe('access reply', () => {
    const reply = { v: 1, ok: true, op: 'access', code: CODE, expiresAt: '2026-11-14T10:02:00.000Z', ttlSeconds: 120 };

    it('round-trips and carries a code of the access alphabet', () => {
      expect(parseControlResponse(line(reply))).toEqual(reply);
      expect(ACCESS_CODE_RE.test(CODE)).toBe(true);
    });

    it('refuses a short or long code, a code outside the alphabet, a bad ttl and extra or missing keys', () => {
      const bad: Record<string, unknown>[] = [
        { ...reply, code: 'a'.repeat(31) },
        { ...reply, code: 'a'.repeat(129) },
        { ...reply, code: 'a'.repeat(31) + '=' },
        { ...reply, code: 5 },
        { ...reply, expiresAt: 5 },
        { ...reply, ttlSeconds: 0 },
        { ...reply, ttlSeconds: -1 },
        { ...reply, ttlSeconds: 1.5 },
        { ...reply, ttlSeconds: '120' },
        { ...reply, extra: 1 },
      ];
      for (const r of bad) expect(parseControlResponse(line(r)), line(r)).toBeNull();
      for (const key of Object.keys(reply)) {
        if (key === 'v' || key === 'ok' || key === 'op') continue;
        const rest = Object.fromEntries(Object.entries(reply).filter(([name]) => name !== key));
        expect(parseControlResponse(line(rest)), key).toBeNull();
      }
    });
  });

  it('round-trips the refusals TERMINALS_LIVE and UNSUPPORTED', () => {
    for (const error of ['TERMINALS_LIVE', 'UNSUPPORTED']) {
      expect(parseControlResponse(line({ v: 1, ok: false, error }))).toEqual({ v: 1, ok: false, error });
    }
  });

  it('keeps the shutdown reply exact: force is a request key only', () => {
    expect(parseControlResponse(line({ v: 1, ok: true, op: 'shutdown', phase: 'stopping', force: true }))).toBeNull();
    expect(parseControlResponse(line({ v: 1, ok: true, op: 'shutdown', phase: 'stopping' }))).not.toBeNull();
  });
});
