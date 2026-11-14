import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANARY } from './canary.ts';
import { FIXTURE_EPOCH_MS } from './clock.ts';
import {
  registryDir,
  registryEntryJson,
  registryFile,
  removeRegistryEntry,
  rewriteRegistryEntry,
  writeRegistryEntry,
  writeRegistryFile,
} from './registry.ts';
import { useTempDirs } from './temp.ts';

const tempDir = useTempDirs();

function home(): string {
  return join(tempDir('registry').path, 'claude-home');
}

function read(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
  return Object.fromEntries(Object.entries(value));
}

describe('registry helper paths', () => {
  it('puts every entry at <claude home>/sessions/<pid>.json', () => {
    const claudeHome = home();
    expect(registryDir(claudeHome)).toBe(join(claudeHome, 'sessions'));
    expect(registryFile(claudeHome, 4242)).toBe(join(claudeHome, 'sessions', '4242.json'));
    for (const pid of [0, -3, 1.5, Number.NaN, 2 ** 40]) {
      expect(() => registryFile(claudeHome, pid), String(pid)).toThrow(RangeError);
    }
  });
});

describe('writeRegistryEntry', () => {
  it('writes the fields of a live interactive session, with neutral defaults', () => {
    const claudeHome = home();
    const path = writeRegistryEntry(claudeHome, { pid: 4242, sessionId: 'sess-1' });
    expect(path).toBe(registryFile(claudeHome, 4242));
    const entry = read(path);
    expect(entry).toEqual({
      pid: 4242,
      sessionId: 'sess-1',
      cwd: join(claudeHome, 'FIXTURE-cwd'),
      startedAt: FIXTURE_EPOCH_MS,
      version: '0.0.0-fixture',
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'idle',
      updatedAt: FIXTURE_EPOCH_MS,
    });
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(registryEntryJson(claudeHome, { pid: 4242, sessionId: 'sess-1' })).toEqual(entry);
  });

  it('takes every field from the caller and keeps unknown fields of the survey as they are', () => {
    const claudeHome = home();
    const path = writeRegistryEntry(claudeHome, {
      pid: 17,
      sessionId: 'sess-2',
      status: 'waiting',
      waitingFor: 'approve the plan',
      cwd: join(claudeHome, 'FIXTURE-work'),
      startedAt: FIXTURE_EPOCH_MS + 5000,
      updatedAt: FIXTURE_EPOCH_MS + 9000,
      kind: 'bg',
      entrypoint: 'sdk',
      version: '9.9.9-fixture',
      extra: { name: 'FIXTURE name', nameSource: 'user', procStart: '12345' },
    });
    expect(read(path)).toMatchObject({
      pid: 17,
      status: 'waiting',
      waitingFor: 'approve the plan',
      startedAt: FIXTURE_EPOCH_MS + 5000,
      updatedAt: FIXTURE_EPOCH_MS + 9000,
      kind: 'bg',
      entrypoint: 'sdk',
      version: '9.9.9-fixture',
      name: 'FIXTURE name',
      nameSource: 'user',
      procStart: '12345',
    });
  });

  it('accepts a status the engine does not know, so the loose reader can be tested', () => {
    const entry = read(writeRegistryEntry(home(), { pid: 18, sessionId: 'sess-3', status: 'paused' }));
    expect(entry['status']).toBe('paused');
  });

  it('writes a key decoy that holds only the canary, and only when asked', () => {
    const claudeHome = home();
    writeRegistryEntry(claudeHome, { pid: 20, sessionId: 'a' });
    expect(readdirSync(registryDir(claudeHome))).toEqual(['20.json']);
    writeRegistryEntry(claudeHome, { pid: 21, sessionId: 'b' }, { keyDecoy: true });
    expect(readdirSync(registryDir(claudeHome)).sort()).toEqual(['20.json', '21.json', '21.key']);
    expect(readFileSync(join(registryDir(claudeHome), '21.key'), 'utf8')).toBe(CANARY.key);
  });

  it('sets the modification time from the caller, never from the clock', () => {
    const claudeHome = home();
    const mtimeMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    const path = writeRegistryEntry(claudeHome, { pid: 22, sessionId: 'c' }, { keyDecoy: true, mtimeMs });
    expect(Math.abs(statSync(path).mtimeMs - mtimeMs)).toBeLessThan(1000);
    expect(Math.abs(statSync(join(registryDir(claudeHome), '22.key')).mtimeMs - mtimeMs)).toBeLessThan(1000);
  });

  it('refuses a pid that is not a positive integer and a status or field of the wrong type', () => {
    const claudeHome = home();
    expect(() => writeRegistryEntry(claudeHome, { pid: 0, sessionId: 'x' })).toThrow(RangeError);
    expect(() => writeRegistryEntry(claudeHome, { pid: 1.5, sessionId: 'x' })).toThrow(RangeError);
    expect(existsSync(registryDir(claudeHome))).toBe(false);
  });

  it('replaces an entry that is already there', () => {
    const claudeHome = home();
    writeRegistryEntry(claudeHome, { pid: 30, sessionId: 'old', status: 'busy' });
    const path = writeRegistryEntry(claudeHome, { pid: 30, sessionId: 'new' });
    expect(read(path)).toMatchObject({ sessionId: 'new', status: 'idle' });
  });
});

describe('rewriteRegistryEntry', () => {
  it('merges a patch into the file and keeps the rest, as a client does when the id changes', () => {
    const claudeHome = home();
    writeRegistryEntry(claudeHome, {
      pid: 40,
      sessionId: 'before',
      status: 'waiting',
      waitingFor: 'input',
      extra: { name: 'FIXTURE name' },
    });
    const path = rewriteRegistryEntry(claudeHome, 40, { sessionId: 'after', status: 'busy', drop: ['waitingFor'] });
    const entry = read(path);
    expect(entry['sessionId']).toBe('after');
    expect(entry['status']).toBe('busy');
    expect('waitingFor' in entry).toBe(false);
    expect(entry['name']).toBe('FIXTURE name');
    expect(entry['pid']).toBe(40);
    expect(entry['startedAt']).toBe(FIXTURE_EPOCH_MS);
  });

  it('can set the fields it merges, including the extra ones, and the modification time', () => {
    const claudeHome = home();
    writeRegistryEntry(claudeHome, { pid: 41, sessionId: 's' });
    const mtimeMs = Date.UTC(2026, 5, 6, 7, 8, 9);
    const path = rewriteRegistryEntry(
      claudeHome,
      41,
      { updatedAt: FIXTURE_EPOCH_MS + 1000, waitingFor: 'x', extra: { name: 'FIXTURE renamed' } },
      { mtimeMs },
    );
    expect(read(path)).toMatchObject({ updatedAt: FIXTURE_EPOCH_MS + 1000, waitingFor: 'x', name: 'FIXTURE renamed' });
    expect(Math.abs(statSync(path).mtimeMs - mtimeMs)).toBeLessThan(1000);
  });

  it('throws for an entry that does not exist, naming the pid', () => {
    expect(() => rewriteRegistryEntry(home(), 99, { status: 'busy' })).toThrow(/99/);
  });

  it('throws for a file that is not a JSON object', () => {
    const claudeHome = home();
    writeRegistryFile(claudeHome, '50.json', '[1,2]');
    expect(() => rewriteRegistryEntry(claudeHome, 50, { status: 'busy' })).toThrow(/not a JSON object/);
  });
});

describe('removeRegistryEntry', () => {
  it('removes the entry and its decoy and says whether there was one', () => {
    const claudeHome = home();
    writeRegistryEntry(claudeHome, { pid: 60, sessionId: 'a' }, { keyDecoy: true });
    writeRegistryEntry(claudeHome, { pid: 61, sessionId: 'b' }, { keyDecoy: true });
    expect(removeRegistryEntry(claudeHome, 60)).toBe(true);
    expect(readdirSync(registryDir(claudeHome)).sort()).toEqual(['61.json', '61.key']);
    expect(removeRegistryEntry(claudeHome, 60)).toBe(false);
    expect(removeRegistryEntry(join(tempDir('registry-none').path, 'nothing'), 1)).toBe(false);
  });
});

describe('writeRegistryFile', () => {
  it('writes raw bytes under the name given, for corrupt, odd and oversize files', () => {
    const claudeHome = home();
    const broken = writeRegistryFile(claudeHome, '70.json', '{"pid": 70,');
    expect(readFileSync(broken, 'utf8')).toBe('{"pid": 70,');
    const big = writeRegistryFile(claudeHome, '71.json', Buffer.alloc(65 * 1024, 0x20));
    expect(statSync(big).size).toBe(65 * 1024);
    const odd = writeRegistryFile(claudeHome, 'not-a-pid.json', '{}', { mtimeMs: Date.UTC(2026, 1, 1) });
    expect(existsSync(odd)).toBe(true);
    expect(readdirSync(registryDir(claudeHome)).sort()).toEqual(['70.json', '71.json', 'not-a-pid.json']);
  });

  it('refuses a name that is not a plain file name', () => {
    const claudeHome = home();
    for (const name of ['', '.', '..', '../x.json', 'a/b.json', 'a\\b.json']) {
      expect(() => writeRegistryFile(claudeHome, name, '{}'), name).toThrow(RangeError);
    }
    expect(existsSync(registryDir(claudeHome))).toBe(false);
  });
});
