import { describe, expect, it } from 'vitest';

import { BackupManifestSchema } from './files/backup-manifest.ts';
import { InstanceFileSchema } from './files/instance.ts';
import { StateFileSchema, stateEngine } from './files/state.ts';
import {
  IsoSecondsZ,
  RESERVED_SLUGS,
  SLUG_RE,
  SLUG_RULE_TEXT,
  Semver,
  UUID_V4_RE,
  isValidSlug,
  slugify,
} from './ids.ts';

const ID = '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11';
const HEX64 = 'a'.repeat(64);
/** Latin capital I with dot above: lowercases to two code points. */
const DOTTED_I = String.fromCharCode(0x130);

describe('identifier patterns', () => {
  it('accepts lowercase uuid v4 and rejects other versions, case and shapes', () => {
    expect(UUID_V4_RE.test(ID)).toBe(true);
    expect(UUID_V4_RE.test('0b9f3f3e-6f0e-1c1e-9a53-0f4f2f1c9d11')).toBe(false); // version 1
    expect(UUID_V4_RE.test('0b9f3f3e-6f0e-4c1e-1a53-0f4f2f1c9d11')).toBe(false); // variant
    expect(UUID_V4_RE.test(ID.toUpperCase())).toBe(false);
    expect(UUID_V4_RE.test(`${ID}\n`)).toBe(false);
    expect(UUID_V4_RE.test('')).toBe(false);
  });

  it('SLUG_RE is the registry pattern', () => {
    expect(SLUG_RE.source).toBe('^[a-z0-9][a-z0-9-]{0,47}$');
    expect(SLUG_RE.test('a')).toBe(true);
    expect(SLUG_RE.test('9-lives')).toBe(true);
    expect(SLUG_RE.test('a'.repeat(48))).toBe(true);
    expect(SLUG_RE.test('a'.repeat(49))).toBe(false);
    for (const bad of ['', '-a', 'A', 'a_b', 'a b', 'a/b', 'a.b', 'ä', 'a\n']) {
      expect(SLUG_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects Windows device names, and only them', () => {
    const devices = [
      'con',
      'prn',
      'aux',
      'nul',
      ...Array.from({ length: 10 }, (_, i) => [`com${i}`, `lpt${i}`]).flat(),
    ];
    expect([...RESERVED_SLUGS].sort()).toEqual([...devices].sort());
    for (const name of devices) {
      expect(SLUG_RE.test(name)).toBe(true); // the pattern alone admits them
      expect(isValidSlug(name), name).toBe(false);
    }
    for (const ok of ['com10', 'lpt', 'console', 'con-1', 'aux1', 'nul0', 'my-com1']) {
      expect(isValidSlug(ok), ok).toBe(true);
    }
    expect(isValidSlug('Bad')).toBe(false);
  });

  it('keeps the legacy message text for an invalid slug', () => {
    expect(SLUG_RULE_TEXT).toBe('use lowercase letters, digits and hyphens, at most 48 characters');
  });
});

describe('slugify (legacy golden)', () => {
  it('matches the golden example', () => {
    expect(slugify('Nightly build: Steps A/B')).toBe('nightly-build-steps-a-b');
  });

  it('lowercases, collapses runs, trims hyphens', () => {
    expect(slugify('  Hello,   World!  ')).toBe('hello-world');
    expect(slugify('a__b..c')).toBe('a-b-c');
    expect(slugify('---x---')).toBe('x');
  });

  it('cuts to 48 characters and trims again', () => {
    expect(slugify('a'.repeat(60))).toBe('a'.repeat(48));
    const name = `${'a'.repeat(47)} bbb`; // the cut lands right after the separator
    expect(slugify(name)).toBe('a'.repeat(47));
    expect(slugify(name).length).toBeLessThanOrEqual(48);
  });

  it('falls back to "task" when nothing is left', () => {
    expect(slugify('')).toBe('task');
    expect(slugify('!!!')).toBe('task');
    expect(slugify('Äöü')).toBe('task');
    expect(slugify(String.fromCharCode(0x65e5, 0x672c, 0x8a9e))).toBe('task');
  });

  it('always produces something SLUG_RE accepts', () => {
    for (const name of ['x', 'Nightly build', '9 lives', 'a'.repeat(100), `${DOTTED_I}stanbul`]) {
      expect(SLUG_RE.test(slugify(name)), name).toBe(true);
    }
  });
});

describe('IsoSecondsZ and Semver', () => {
  it('IsoSecondsZ accepts only YYYY-MM-DDTHH:MM:SSZ', () => {
    expect(IsoSecondsZ.safeParse('2026-10-11T08:09:10Z').success).toBe(true);
    for (const bad of [
      '2026-10-11T08:09:10.123Z',
      '2026-10-11 08:09:10Z',
      '2026-10-11T08:09:10',
      '2026-10-11T08:09:10+00:00',
      '',
    ]) {
      expect(IsoSecondsZ.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('Semver accepts MAJOR.MINOR.PATCH with an optional pre-release', () => {
    for (const ok of ['3.0.0', '0.0.1', '10.20.30', '3.1.0-rc.1', '3.0.0-alpha']) {
      expect(Semver.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['3.0', '03.0.0', 'v3.0.0', '3.0.0+build', '3.0.0-', '']) {
      expect(Semver.safeParse(bad).success, bad).toBe(false);
    }
  });
});

const instance = {
  schema_version: 1,
  instanceId: ID,
  slug: 'nightly-build',
  createdAt: '2026-10-11T08:09:10Z',
  createdBy: 'mcs 3.0.0',
  runtimeVersion: '3.0.0',
  dbSchemaVersion: 0,
  engine: 'node',
  hooks: { enabled: false },
  upgradedAt: null,
} as const;

describe('InstanceFileSchema (01 1.5)', () => {
  it('parses a complete file and keeps the documented key order', () => {
    const parsed = InstanceFileSchema.parse(instance);
    expect(Object.keys(parsed)).toEqual([
      'schema_version',
      'instanceId',
      'slug',
      'createdAt',
      'createdBy',
      'runtimeVersion',
      'dbSchemaVersion',
      'engine',
      'hooks',
      'upgradedAt',
    ]);
  });

  it('is strict and checks every field', () => {
    const ok = (patch: Record<string, unknown>) => InstanceFileSchema.safeParse({ ...instance, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ schema_version: 2 })).toBe(false);
    expect(ok({ instanceId: 'x' })).toBe(false);
    expect(ok({ slug: 'Not A Slug' })).toBe(false);
    expect(ok({ createdAt: '2026-10-11' })).toBe(false);
    expect(ok({ createdBy: 'mcs' })).toBe(false);
    expect(ok({ createdBy: 'mcs 3.1.0-rc.1' })).toBe(true);
    expect(ok({ dbSchemaVersion: -1 })).toBe(false);
    expect(ok({ dbSchemaVersion: 1.5 })).toBe(false);
    expect(ok({ engine: 'python' })).toBe(false);
    expect(ok({ engine: 'legacy' })).toBe(true);
    expect(ok({ hooks: { enabled: true, more: 1 } })).toBe(false);
    expect(ok({ upgradedAt: '2026-10-12T00:00:00Z' })).toBe(true);
    expect(ok({ upgradedAt: undefined })).toBe(false);
  });
});

const legacyState = {
  pid: 4242,
  url: 'http://127.0.0.1:8765',
  port: 8765,
  started: 1760170150.5,
  version: '2.0.2',
  task: null,
  config: null,
};
const nodeState = {
  pid: 4242,
  url: 'http://127.0.0.1:18765',
  port: 18765,
  started: 1760170150.5,
  version: '3.0.0',
  task: 'nightly-build',
  config: null,
  schema_version: 1,
  engine: 'node',
  instanceId: ID,
  runtimeVersion: '3.0.0',
  codeStamp: 'a1b2c3d4e5',
  startedAt: '2026-10-11T08:09:10.500Z',
  nodeVersion: 'v24.14.1',
  control: 'pipe-address',
} as const;

describe('StateFileSchema (01 1.7)', () => {
  it('reads a legacy state file and classifies it as legacy', () => {
    const s = StateFileSchema.parse(legacyState);
    expect(stateEngine(s)).toBe('legacy');
  });

  it('reads a node state file and classifies it as node', () => {
    const s = StateFileSchema.parse(nodeState);
    expect(stateEngine(s)).toBe('node');
  });

  it('tolerates unknown keys (future versions)', () => {
    expect(StateFileSchema.safeParse({ ...legacyState, future: 'x' }).success).toBe(true);
    expect(StateFileSchema.safeParse({ ...nodeState, future: { nested: true } }).success).toBe(true);
  });

  it('requires instanceId, codeStamp and runtimeVersion for engine node', () => {
    for (const drop of ['instanceId', 'codeStamp', 'runtimeVersion'] as const) {
      const rest = Object.fromEntries(Object.entries(nodeState).filter(([key]) => key !== drop));
      const r = StateFileSchema.safeParse(rest);
      expect(r.success, drop).toBe(false);
      expect(r.error?.issues[0]?.message).toBe('node state needs instanceId, codeStamp, runtimeVersion');
    }
  });

  it('rejects malformed values', () => {
    const ok = (patch: Record<string, unknown>) => StateFileSchema.safeParse({ ...nodeState, ...patch }).success;
    expect(ok({})).toBe(true);
    expect(ok({ pid: 0 })).toBe(false);
    expect(ok({ pid: 1.5 })).toBe(false);
    expect(ok({ url: 'http://localhost:1' })).toBe(false);
    expect(ok({ url: 'http://127.0.0.1:18765/' })).toBe(false);
    expect(ok({ port: 0 })).toBe(false);
    expect(ok({ port: 65536 })).toBe(false);
    expect(ok({ started: -1 })).toBe(false);
    expect(ok({ codeStamp: 'ABCDEF1234' })).toBe(false);
    expect(ok({ codeStamp: 'a1b2c3d4e' })).toBe(false);
    expect(ok({ engine: 'legacy' })).toBe(false);
    expect(ok({ instanceId: 'nope' })).toBe(false);
  });
});

describe('BackupManifestSchema (01 5.5)', () => {
  const manifest = {
    schema_version: 1,
    backupId: '20261011T080910Z-manual',
    instanceId: ID,
    slug: 'nightly-build',
    createdAt: '2026-10-11T08:09:10Z',
    reason: 'manual',
    runtimeVersion: '3.0.0',
    dbSchemaVersion: 4,
    dbCopy: 'online',
    files: [{ path: 'monitor.db', bytes: 4096, sha256: HEX64 }],
  } as const;

  it('parses a complete manifest and is strict', () => {
    expect(BackupManifestSchema.safeParse(manifest).success).toBe(true);
    expect(BackupManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
    expect(BackupManifestSchema.safeParse({ ...manifest, files: [{ ...manifest.files[0], extra: 1 }] }).success).toBe(
      false,
    );
  });

  it('accepts exactly the documented reasons and copy modes', () => {
    for (const reason of ['manual', 'upgrade', 'config-migrate', 'pre-restore', 'cleanup', 'db-rebuild']) {
      expect(BackupManifestSchema.safeParse({ ...manifest, reason }).success, reason).toBe(true);
    }
    expect(BackupManifestSchema.safeParse({ ...manifest, reason: 'other' }).success).toBe(false);
    for (const dbCopy of ['online', 'raw', 'none']) {
      expect(BackupManifestSchema.safeParse({ ...manifest, dbCopy }).success, dbCopy).toBe(true);
    }
    expect(BackupManifestSchema.safeParse({ ...manifest, dbCopy: 'copy' }).success).toBe(false);
  });

  it('checks the file rows', () => {
    const rows = (files: unknown) => BackupManifestSchema.safeParse({ ...manifest, files }).success;
    expect(rows([])).toBe(true);
    expect(rows([{ path: 'a', bytes: -1, sha256: HEX64 }])).toBe(false);
    expect(rows([{ path: 'a', bytes: 1.5, sha256: HEX64 }])).toBe(false);
    expect(rows([{ path: 'a', bytes: 1, sha256: 'A'.repeat(64) }])).toBe(false);
    expect(rows([{ path: 'a', bytes: 1, sha256: 'a'.repeat(63) }])).toBe(false);
  });
});
