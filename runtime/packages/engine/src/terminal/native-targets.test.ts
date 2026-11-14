import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  MIN_WINDOWS_BUILD,
  NODE_PTY_PACKAGE,
  SHIPPED_TARGETS,
  nativeDirOf,
  nativeEntryOf,
  targetOf,
  windowsBuildOk,
} from './native-targets.ts';

interface PinsFile {
  readonly package: string;
  readonly version: string;
  readonly targets: Readonly<Record<string, unknown>>;
}

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
}

function isPins(value: unknown): value is PinsFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'package' in value &&
    typeof value.package === 'string' &&
    'version' in value &&
    typeof value.version === 'string' &&
    'targets' in value &&
    typeof value.targets === 'object' &&
    value.targets !== null
  );
}

describe('native targets: the shipped list agrees with the reviewed pins', () => {
  const pins = readJson('../../../../scripts/native-pins.json');

  it('names the same package as native-pins.json and the engine dependency', () => {
    if (!isPins(pins)) throw new Error('native-pins.json has an unexpected shape');
    expect(NODE_PTY_PACKAGE).toBe(pins.package);
    const manifest = readJson('../../package.json');
    expect(manifest).toMatchObject({ dependencies: { [NODE_PTY_PACKAGE]: pins.version } });
  });

  it('ships exactly the targets that native-pins.json pins', () => {
    if (!isPins(pins)) throw new Error('native-pins.json has an unexpected shape');
    expect([...SHIPPED_TARGETS].sort()).toEqual(Object.keys(pins.targets).sort());
  });

  it('ships Windows x64 and arm64 only (spec Q1)', () => {
    expect([...SHIPPED_TARGETS]).toEqual(['win32-x64', 'win32-arm64']);
  });
});

describe('targetOf', () => {
  it.each([
    ['win32', 'x64', 'win32-x64'],
    ['win32', 'arm64', 'win32-arm64'],
  ] as const)('%s on %s is the shipped target %s', (platform, arch, target) => {
    expect(targetOf(platform, arch)).toBe(target);
  });

  it.each([
    ['win32', 'ia32'],
    ['win32', 'arm'],
    ['win32', 'x86'],
    ['win32', ''],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['other', 'x64'],
  ] as const)('%s on %s is not shipped', (platform, arch) => {
    expect(targetOf(platform, arch)).toBeNull();
  });
});

describe('nativeDirOf and nativeEntryOf', () => {
  const layout = { runtimeDir: 'C:\\caw\\skill\\bundle' };

  it('puts a Windows target under native/<target> of the bundle folder, with Windows separators', () => {
    expect(nativeDirOf(layout, 'win32-x64')).toBe('C:\\caw\\skill\\bundle\\native\\win32-x64');
    expect(nativeDirOf(layout, 'win32-arm64')).toBe('C:\\caw\\skill\\bundle\\native\\win32-arm64');
  });

  it('points the entry at lib/index.js of the platform package', () => {
    expect(nativeEntryOf(layout, 'win32-x64')).toBe('C:\\caw\\skill\\bundle\\native\\win32-x64\\lib\\index.js');
  });

  it('copes with a bundle folder whose name has a space and a non-ASCII letter', () => {
    const odd = { runtimeDir: 'D:\\my tools\\skill ä\\bundle' };
    expect(nativeEntryOf(odd, 'win32-arm64')).toBe('D:\\my tools\\skill ä\\bundle\\native\\win32-arm64\\lib\\index.js');
  });
});

describe('windowsBuildOk (ConPTY needs Windows 10 1809, build 17763)', () => {
  it('names the minimum build', () => {
    expect(MIN_WINDOWS_BUILD).toBe(17_763);
  });

  it.each([
    ['10.0.17763', true],
    ['10.0.17764', true],
    ['10.0.19045', true],
    ['10.0.22631', true],
    ['10.0.26200', true],
    ['10.0.100000', true],
    ['10.1.17763', true],
    ['11.0.1', true],
    ['10.0.17762', false],
    ['10.0.17134', false],
    ['10.0.10240', false],
    ['10.0.0', false],
    ['6.3.9600', false],
    ['6.1.7601', false],
    ['5.1.2600', false],
  ])('release %s -> %s', (release, ok) => {
    expect(windowsBuildOk(release)).toBe(ok);
  });

  it.each(['', ' ', 'abc', '10', '10.0', '10.0.x', '-10.0.26200', '10..26200', 'v10.0.26200', '10.0.-1'])(
    'refuses a release that is not <major>.<minor>.<build>: %j',
    (release) => {
      expect(windowsBuildOk(release)).toBe(false);
    },
  );

  it('reads only the leading numbers, so a suffix does not change the answer', () => {
    expect(windowsBuildOk('10.0.26200-custom')).toBe(true);
    expect(windowsBuildOk('10.0.17762-custom')).toBe(false);
  });
});
