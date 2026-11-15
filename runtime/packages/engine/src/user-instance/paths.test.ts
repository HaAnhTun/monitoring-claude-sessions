// The places of the user instance (06 1.2): the one module that names its folders.
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { McsError } from '@mcs/shared';
import { FakeClock, makeJunction, useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../log/logger.ts';
import { pathsCaseInsensitive } from '../platform/host.ts';
import {
  USER_DEFAULT_PORT,
  USER_INSTANCE_NAME,
  USER_INSTANCE_SLUG,
  USER_ROOT_DIRNAME,
  isUserRoot,
  userBrowserProfileDirOf,
  userInstanceDirOf,
  userOpContext,
  userRootOf,
} from './paths.ts';

const makeTemp = useTempDirs();

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  stats: { droppedFields: 0, rotations: 0, rotateFailures: 0, writeFailures: 0 },
  close: () => Promise.resolve(),
};

/** An environment whose home is a fresh temp folder (the real MCS home is never read). */
function envOf(): { env: Record<string, string>; home: string } {
  const home = makeTemp('user-paths').path;
  return { env: { MCS_HOME: home }, home };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('constants', () => {
  it('names the user instance, its slug, its root folder and its port', () => {
    expect(USER_INSTANCE_SLUG).toBe('user');
    expect(USER_ROOT_DIRNAME).toBe('instances');
    expect(USER_DEFAULT_PORT).toBe(7690);
    expect(USER_INSTANCE_NAME).toBe('Claude Agent Workspace');
  });
});

describe('userRootOf, userInstanceDirOf, userBrowserProfileDirOf', () => {
  it('puts the user root at <MCS_HOME>/instances and the instance and the browser profile below it', () => {
    const { env, home } = envOf();
    expect(userRootOf(env)).toBe(path.resolve(home, 'instances'));
    expect(userInstanceDirOf(env)).toBe(path.resolve(home, 'instances', 'user'));
    expect(userBrowserProfileDirOf(env)).toBe(path.resolve(home, 'instances', 'user', 'run', 'browser-profile'));
  });

  it('resolves the mixed separators of the default home to one absolute spelling', () => {
    const { home } = envOf();
    // LOCALAPPDATA gives `<dir>/mcs` with a forward slash on Windows; XDG_STATE_HOME does the same elsewhere
    const root = userRootOf({ LOCALAPPDATA: home, XDG_STATE_HOME: home, HOME: home, USERPROFILE: home });
    expect(path.isAbsolute(root)).toBe(true);
    expect(root).toBe(path.normalize(root));
    expect(path.basename(root)).toBe('instances');
    expect(path.basename(path.dirname(root))).toBe('mcs');
  });

  it('CONFIG_INVALID, not a bare Error, when no home can be found', () => {
    for (const read of [userRootOf, userInstanceDirOf, userBrowserProfileDirOf]) {
      const error = thrownBy(() => read({}));
      expect(error).toBeInstanceOf(McsError);
      expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });
});

describe('isUserRoot', () => {
  it('is true for the user root and false for anything else', () => {
    const { env, home } = envOf();
    expect(isUserRoot(userRootOf(env), env)).toBe(true);
    expect(isUserRoot(path.join(userRootOf(env), '.'), env)).toBe(true);
    expect(isUserRoot(home, env)).toBe(false);
    expect(isUserRoot(path.join(userRootOf(env), 'user'), env)).toBe(false);
    expect(isUserRoot(path.join(makeTemp('other-root').path, 'instances'), env)).toBe(false);
  });

  it('compares canonical places: a junction to the user root is the user root', () => {
    const { env, home } = envOf();
    mkdirSync(userRootOf(env), { recursive: true });
    const link = path.join(makeTemp('link').path, 'alias');
    makeJunction(link, userRootOf(env));
    expect(isUserRoot(link, env)).toBe(true);
    expect(isUserRoot(path.join(home, 'elsewhere'), env)).toBe(false);
  });

  it('applies the case rule of the host', () => {
    const { env } = envOf();
    const swapped = userRootOf(env).replace(/instances$/, 'INSTANCES');
    expect(isUserRoot(swapped, env)).toBe(pathsCaseInsensitive);
  });
});

describe('userOpContext', () => {
  it('makes the repository and the tasks root the user root and keeps every other field', () => {
    const { env } = envOf();
    const base = {
      skillDir: path.resolve('skill'),
      runtimeDir: path.resolve('skill', 'runtime'),
      launcherPath: path.resolve('skill', 'scripts', 'caw.mjs'),
      env,
      clock: new FakeClock(1),
      log: silent,
    };
    const ctx = userOpContext(base);
    expect(ctx.repo).toBe(userRootOf(env));
    expect(ctx.root).toBe(userRootOf(env));
    expect(ctx).toMatchObject(base);
    expect(Object.keys(ctx).sort()).toEqual([...Object.keys(base), 'repo', 'root'].sort());
  });

  it('CONFIG_INVALID without a home', () => {
    const error = thrownBy(() =>
      userOpContext({
        skillDir: path.resolve('s'),
        runtimeDir: path.resolve('s', 'runtime'),
        launcherPath: path.resolve('s', 'caw.mjs'),
        env: {},
        clock: new FakeClock(1),
        log: silent,
      }),
    );
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
