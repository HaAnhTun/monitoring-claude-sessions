// The control address (01 4.3): the one place that names the pipe or the socket of an instance. The server, the engine probe and
// the CLI all use it, so the table per host is proved here once.
import { describe, expect, it } from 'vitest';

import { controlAddress, type AddressHost } from './control-address.ts';

const ID = 'abcdef01-abcd-4bcd-8bcd-abcdef012345';
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

const host = (platform: AddressHost['platform'], uid: number | null, tmpdir = '/tmp'): AddressHost => ({
  platform,
  tmpdir,
  uid,
});

describe('controlAddress (01 4.3)', () => {
  it('is the named pipe mcs-<id> on Windows', () => {
    expect(controlAddress(ID, host('win32', null, 'C:/tmp'))).toBe(
      `${BACKSLASH}${BACKSLASH}.${BACKSLASH}pipe${BACKSLASH}mcs-${ID}`,
    );
  });

  it('is an abstract socket on Linux, whatever the temp folder and the user are', () => {
    expect(controlAddress(ID, host('linux', 1000))).toBe(`${NUL}mcs-${ID}`);
    expect(controlAddress(ID, host('linux', null, '/elsewhere'))).toBe(`${NUL}mcs-${ID}`);
  });

  it('is a socket file in a per-user folder of the temp folder elsewhere (uid 0 when there is none)', () => {
    expect(controlAddress(ID, host('darwin', 501, '/var/tmp'))).toBe(`/var/tmp/mcs-501/${ID}.sock`);
    expect(controlAddress(ID, host('other', 7))).toBe(`/tmp/mcs-7/${ID}.sock`);
    expect(controlAddress(ID, host('other', null))).toBe(`/tmp/mcs-0/${ID}.sock`);
  });

  it('joins with the separator of the temp folder and does not double a trailing one', () => {
    expect(controlAddress(ID, host('darwin', 501, '/var/folders/x/T/'))).toBe(`/var/folders/x/T/mcs-501/${ID}.sock`);
    expect(controlAddress(ID, host('other', 5, `C:${BACKSLASH}t${BACKSLASH}`))).toBe(
      `C:${BACKSLASH}t${BACKSLASH}mcs-5${BACKSLASH}${ID}.sock`,
    );
    expect(controlAddress(ID, host('other', 5, '/'))).toBe(`/mcs-5/${ID}.sock`);
  });

  it('refuses an id that is not a version 4 uuid (it becomes part of a path)', () => {
    for (const bad of ['', 'x', `..${BACKSLASH}evil`, '../evil', `${ID}/..`, ID.toUpperCase(), `${ID}${NUL}`]) {
      expect(() => controlAddress(bad, host('win32', null)), bad).toThrow(RangeError);
      expect(() => controlAddress(bad, host('other', 1)), bad).toThrow(RangeError);
    }
  });
});
