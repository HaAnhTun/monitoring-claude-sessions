/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Semver } from './ids.ts';
import { RUNTIME_VERSION } from './version.ts';

function readVersion(relative: string): unknown {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === 'object' && parsed !== null && 'version' in parsed ? parsed.version : undefined;
}

describe('RUNTIME_VERSION', () => {
  it('is a semver string', () => {
    expect(Semver.safeParse(RUNTIME_VERSION).success).toBe(true);
  });

  it('equals the version of the runtime workspace manifest', () => {
    expect(RUNTIME_VERSION).toBe(readVersion('../../../package.json'));
  });

  it('equals the version of the shared package manifest', () => {
    expect(RUNTIME_VERSION).toBe(readVersion('../package.json'));
  });
});
