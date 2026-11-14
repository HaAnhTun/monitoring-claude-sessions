// The identity file of an instance (01 1.5, 06 1.3): `kind` is optional, strict, and written only for `user`.
import { describe, expect, it } from 'vitest';

import { InstanceFileSchema, InstanceKindSchema, instanceKindOf } from './instance.ts';

const BASE = {
  schema_version: 1,
  instanceId: '0b9f3f3e-6f0e-4c1e-9a53-0f4f2f1c9d11',
  slug: 'demo',
  createdAt: '2026-11-14T10:00:00Z',
  createdBy: 'mcs 4.0.0',
  runtimeVersion: '4.0.0',
  dbSchemaVersion: 0,
  engine: 'node',
  hooks: { enabled: true },
  upgradedAt: null,
} as const;

describe('InstanceKindSchema', () => {
  it('is task or user', () => {
    expect(InstanceKindSchema.options).toEqual(['task', 'user']);
    expect(InstanceKindSchema.safeParse('task').success).toBe(true);
    expect(InstanceKindSchema.safeParse('user').success).toBe(true);
    expect(InstanceKindSchema.safeParse('admin').success).toBe(false);
    expect(InstanceKindSchema.safeParse('User').success).toBe(false);
    expect(InstanceKindSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('InstanceFileSchema kind', () => {
  it('stays optional: a task file without the key parses and keeps no key', () => {
    const parsed = InstanceFileSchema.parse(BASE);
    expect(parsed).toEqual(BASE);
    expect('kind' in parsed).toBe(false);
  });

  it('accepts task and user', () => {
    expect(InstanceFileSchema.parse({ ...BASE, kind: 'user' }).kind).toBe('user');
    expect(InstanceFileSchema.parse({ ...BASE, kind: 'task' }).kind).toBe('task');
  });

  it('refuses another value, null and a wrong type', () => {
    for (const kind of ['admin', '', null, 1, true, ['user']]) {
      expect(InstanceFileSchema.safeParse({ ...BASE, kind }).success, String(kind)).toBe(false);
    }
  });

  it('stays strict about every other key', () => {
    expect(InstanceFileSchema.safeParse({ ...BASE, kind: 'user', extra: 1 }).success).toBe(false);
    expect(InstanceFileSchema.safeParse({ ...BASE, Kind: 'user' }).success).toBe(false);
  });

  it('keeps schema_version 1', () => {
    expect(InstanceFileSchema.safeParse({ ...BASE, kind: 'user', schema_version: 2 }).success).toBe(false);
  });

  it('writes kind right after engine in the key order of the schema', () => {
    const keys = Object.keys(InstanceFileSchema.shape);
    expect(keys.indexOf('kind')).toBe(keys.indexOf('engine') + 1);
  });
});

describe('instanceKindOf', () => {
  it('reads an absent kind as task', () => {
    expect(instanceKindOf({})).toBe('task');
    expect(instanceKindOf(InstanceFileSchema.parse(BASE))).toBe('task');
  });

  it('returns the recorded kind', () => {
    expect(instanceKindOf({ kind: 'user' })).toBe('user');
    expect(instanceKindOf({ kind: 'task' })).toBe('task');
  });
});
