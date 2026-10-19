// The control protocol parsers (01 4.3, ADR 0005): the reply codes are a closed list, and `INTERNAL` is one of them.
import { describe, expect, it } from 'vitest';

import {
  CONTROL_ERROR_CODES,
  CONTROL_REQUEST_MAX_BYTES,
  parseControlRequest,
  parseControlResponse,
  type ControlErrorCode,
} from './control.ts';

const ID = 'abcdef01-abcd-4bcd-8bcd-abcdef012345';
const TOKEN = 'ab'.repeat(32);

describe('ControlErrorCode', () => {
  it('is the closed list, with INTERNAL for a service that threw', () => {
    expect([...CONTROL_ERROR_CODES]).toEqual([
      'BAD_REQUEST',
      'FORBIDDEN',
      'INSTANCE_MISMATCH',
      'NOT_READY',
      'BACKUP_FAILED',
      'INTERNAL',
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
