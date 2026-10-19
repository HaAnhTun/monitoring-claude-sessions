// The install manifest: a register under $MCS_HOME/hooks that is read as empty when it is missing or damaged.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { pathsCaseInsensitive } from '../../platform/host.ts';
import {
  EMPTY_MANIFEST,
  MANIFEST_VERSION,
  hasInstall,
  hooksFolder,
  installsOf,
  manifestKey,
  manifestMutexName,
  manifestPath,
  readManifest,
  removeManifest,
  removesLastInstall,
  withInstall,
  withoutInstall,
  writeManifest,
  type HookInstallRecord,
} from './manifest.ts';

const makeTemp = useTempDirs();

function home(): string {
  return path.join(makeTemp('manifest').path, 'mcs-home');
}

function record(settingsPath: string, over: Partial<HookInstallRecord> = {}): HookInstallRecord {
  return {
    settingsPath: settingsPath.replaceAll('\\', '/'),
    scope: 'file',
    op: 'install',
    at: 1_760_000_000_000,
    events: 21,
    handlerVersion: '4.0.0',
    nodePath: 'C:/FIXTURE/node.exe',
    hookEntryPath: 'C:/FIXTURE/mcs-home/hooks/mcs-hook.mjs',
    async: true,
    backup: null,
    ...over,
  };
}

describe('paths', () => {
  it('keeps the manifest in hooks/installs.json below MCS_HOME', () => {
    const h = home();
    expect(hooksFolder(h)).toBe(path.join(h, 'hooks'));
    expect(manifestPath(h)).toBe(path.join(h, 'hooks', 'installs.json'));
  });

  it('names one mutex per MCS_HOME', () => {
    const h = home();
    expect(manifestMutexName(h)).toMatch(/^mcs-settings-[0-9a-f]{16}$/);
    expect(manifestMutexName(h)).toBe(manifestMutexName(h));
    expect(manifestMutexName(h)).not.toBe(manifestMutexName(home()));
  });

  it('keys a settings file by its absolute path with slashes, ignoring case where the file system does', () => {
    const file = path.join(makeTemp('manifest').path, 'Settings.json');
    const slashed = path.resolve(file).split(path.sep).join('/');
    expect(manifestKey(file)).toBe(pathsCaseInsensitive ? slashed.toLowerCase() : slashed);
    if (pathsCaseInsensitive) expect(manifestKey(file.toUpperCase())).toBe(manifestKey(file));
  });
});

describe('readManifest', () => {
  it('reads a missing manifest as empty, without a problem', async () => {
    expect(await readManifest(home())).toEqual({ manifest: EMPTY_MANIFEST, problem: null });
  });

  it('round-trips what writeManifest wrote, with mode 0600 and a trailing newline', async () => {
    const h = home();
    const a = record(path.join(h, '..', 'a.json'), { scope: 'user' });
    const b = record(path.join(h, '..', 'b.json'), { backup: 'C:/FIXTURE/backup.json', async: false });
    await writeManifest(h, withInstall(withInstall(EMPTY_MANIFEST, a), b));
    const read = await readManifest(h);
    expect(read.problem).toBeNull();
    expect(installsOf(read.manifest)).toEqual([a, b]);
    const text = readFileSync(manifestPath(h), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ v: MANIFEST_VERSION });
    if (process.platform !== 'win32') expect(statSync(manifestPath(h)).mode & 0o777).toBe(0o600);
  });

  it('reads a damaged manifest as empty and says so', async () => {
    const h = home();
    mkdirSync(hooksFolder(h), { recursive: true });
    for (const text of ['', '{ not json', '[]', '{"v":2,"installs":{}}', '{"v":1}', '{"v":1,"installs":[]}']) {
      writeFileSync(manifestPath(h), text);
      const read = await readManifest(h);
      expect(read.manifest).toEqual(EMPTY_MANIFEST);
      expect(read.problem).toBe('the manifest is not valid');
    }
  });

  it('drops the entries that are not valid and keeps the others', async () => {
    const h = home();
    const good = record(path.join(h, '..', 'good.json'));
    mkdirSync(hooksFolder(h), { recursive: true });
    writeFileSync(
      manifestPath(h),
      JSON.stringify({
        v: 1,
        installs: { good: good, bad: { settingsPath: 5 }, worse: null, scope: { ...good, scope: 'global' } },
      }),
    );
    const read = await readManifest(h);
    expect(installsOf(read.manifest)).toEqual([good]);
    expect(read.problem).toBe('3 manifest entries are not valid and were ignored');
  });

  it('reads a manifest that cannot be read (a folder in its place) as empty with a problem', async () => {
    const h = home();
    mkdirSync(manifestPath(h), { recursive: true });
    const read = await readManifest(h);
    expect(read.manifest).toEqual(EMPTY_MANIFEST);
    expect(read.problem).toBe('the manifest could not be read');
  });
});

describe('the register', () => {
  it('adds, replaces and removes an install by its settings file', () => {
    const file = path.join(makeTemp('manifest').path, 'settings.json');
    const first = withInstall(EMPTY_MANIFEST, record(file));
    expect(hasInstall(first, file)).toBe(true);
    const second = withInstall(first, record(file, { events: 3 }));
    expect(installsOf(second)).toHaveLength(1);
    expect(installsOf(second)[0]?.events).toBe(3);
    expect(installsOf(withoutInstall(second, file))).toEqual([]);
    expect(hasInstall(withoutInstall(second, file), file)).toBe(false);
  });

  it('does not change the manifest it was given', () => {
    const file = path.join(makeTemp('manifest').path, 'settings.json');
    const before = withInstall(EMPTY_MANIFEST, record(file));
    withoutInstall(before, file);
    withInstall(before, record(path.join(path.dirname(file), 'other.json')));
    expect(installsOf(before)).toHaveLength(1);
  });

  it('lists installs in the order of their paths', () => {
    const dir = makeTemp('manifest').path;
    const m = withInstall(
      withInstall(EMPTY_MANIFEST, record(path.join(dir, 'b.json'))),
      record(path.join(dir, 'a.json')),
    );
    expect(installsOf(m).map((r) => path.basename(r.settingsPath))).toEqual(['a.json', 'b.json']);
  });
});

describe('removesLastInstall: the copy of the script goes only with the last known install', () => {
  const dir = makeTemp('manifest').path;
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');

  it('is true for the only install', () => {
    expect(removesLastInstall(withInstall(EMPTY_MANIFEST, record(a)), a)).toBe(true);
  });

  it('is false while another install is registered', () => {
    expect(removesLastInstall(withInstall(withInstall(EMPTY_MANIFEST, record(a)), record(b)), a)).toBe(false);
  });

  it('is false for an empty manifest, which cannot say that nobody else uses the copy', () => {
    expect(removesLastInstall(EMPTY_MANIFEST, a)).toBe(false);
  });

  it('is false for a settings file that is not registered while another install is', () => {
    expect(removesLastInstall(withInstall(EMPTY_MANIFEST, record(b)), a)).toBe(false);
  });
});

describe('removeManifest', () => {
  it('deletes the file and an empty hooks folder, and is quiet when there is none', async () => {
    const h = home();
    await writeManifest(h, withInstall(EMPTY_MANIFEST, record(path.join(h, '..', 'a.json'))));
    await removeManifest(h);
    expect(existsSync(hooksFolder(h))).toBe(false);
    await expect(removeManifest(h)).resolves.toBeUndefined();
  });

  it('leaves the hooks folder when the stable copy is still in it', async () => {
    const h = home();
    await writeManifest(h, EMPTY_MANIFEST);
    writeFileSync(path.join(hooksFolder(h), 'mcs-hook.mjs'), '// FIXTURE');
    await removeManifest(h);
    expect(existsSync(manifestPath(h))).toBe(false);
    expect(existsSync(path.join(hooksFolder(h), 'mcs-hook.mjs'))).toBe(true);
  });
});
