// Root files of the repository that tools read: the Node floor file and the bundle scripts (ADR 0061, ADR 0063).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const RUNTIME = join(REPO, 'runtime');

interface Manifest {
  engines: { node: string };
  scripts: Record<string, string>;
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')) as Manifest;
}

describe('.nvmrc', () => {
  const bytes = readFileSync(join(REPO, '.nvmrc'));

  it('holds exactly one line, without a byte order mark', () => {
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString('utf8')).toMatch(/^[^\r\n]+\n?$/);
  });

  it('is the lower bound of the first range of engines.node', () => {
    const first = manifest().engines.node.split('||')[0]?.trim() ?? '';
    const lower = /^\^?(\d+\.\d+\.\d+)$/.exec(first)?.[1];
    expect(lower).toBe('22.22.0');
    expect(bytes.toString('utf8').trim()).toBe(lower);
  });
});

describe('runtime/package.json bundle scripts', () => {
  it('bundle writes the tracked bundle and bundle:check compares it', () => {
    const { scripts } = manifest();
    expect(scripts['bundle']).toBe('node scripts/bundle.mjs');
    expect(scripts['bundle:check']).toBe('node scripts/bundle.mjs --check');
  });
});
