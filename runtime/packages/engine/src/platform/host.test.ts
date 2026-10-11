import { describe, expect, it } from 'vitest';

import { classifyPlatform, hostPlatform, isCaseInsensitive, pathsCaseInsensitive } from './host.ts';

describe('classifyPlatform', () => {
  it('maps the three supported platforms and everything else to other', () => {
    expect(classifyPlatform('win32')).toBe('win32');
    expect(classifyPlatform('linux')).toBe('linux');
    expect(classifyPlatform('darwin')).toBe('darwin');
    expect(classifyPlatform('freebsd')).toBe('other');
    expect(classifyPlatform('aix')).toBe('other');
    expect(classifyPlatform('')).toBe('other');
    expect(classifyPlatform('WIN32')).toBe('other');
  });
});

describe('isCaseInsensitive', () => {
  it('is true for win32 and darwin only', () => {
    expect(isCaseInsensitive('win32')).toBe(true);
    expect(isCaseInsensitive('darwin')).toBe(true);
    expect(isCaseInsensitive('linux')).toBe(false);
    expect(isCaseInsensitive('other')).toBe(false);
  });
});

describe('hostPlatform and pathsCaseInsensitive', () => {
  it('describe the running process, evaluated once', () => {
    expect(hostPlatform).toBe(classifyPlatform(process.platform));
    expect(pathsCaseInsensitive).toBe(isCaseInsensitive(hostPlatform));
  });
});
