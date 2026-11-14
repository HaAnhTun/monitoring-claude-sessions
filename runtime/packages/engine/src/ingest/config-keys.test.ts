// 02 1.2: every `runtime.<section>.<key>` that the sources under `engine/src/{ingest,lifecycle,health,external}` read is a key of the
// table of that section (the 02-owned keys of the shared catalogue). The test greps the source: a key that is added to the code but
// not to the table (and so not to `RuntimeOverridesSchema`, the documentation or the defaults) fails here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { R_KEY_CATALOGUE } from '@mcs/shared';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const FOLDERS = ['ingest', 'lifecycle', 'health', 'external'];
/** The sections of 02 1.2, and `projects` (CAW design 03 2.1: the ingestion keys of its scope switch are read by discovery). */
const SECTIONS = ['spool', 'import', 'ingest', 'health', 'hooks', 'lifecycle', 'board', 'projects'] as const;
const SECTION_ALT = SECTIONS.join('|');

/**
 * The 02 table: `section.key` of every catalogue entry of owner 02, and every key of the `projects` section (its keys are
 * owned by 02 for ingestion, 03 for folders and 06 for the terminal link, but one table lists them).
 */
const TABLE: ReadonlySet<string> = new Set(
  R_KEY_CATALOGUE.filter((entry) => entry.owner === '02' || entry.key.startsWith('projects.')).map(
    (entry) => entry.key,
  ),
);

/** `section.key` of every read in `text`: the full path, or a section that is taken out of `config.runtime` first. */
export function configReadsIn(text: string): string[] {
  const reads = new Set<string>();
  const full = new RegExp(`\\b(?:config\\.runtime|cfg|runtime)\\.(${SECTION_ALT})\\.([A-Za-z0-9_]+)`, 'g');
  for (const match of text.matchAll(full)) reads.add(`${match[1] ?? ''}.${match[2] ?? ''}`);
  // `const { lifecycle, health: h } = config.runtime;` then `lifecycle.activeSeconds` and `h.backlogWarnMs`; a file name such as
  // `health.ts` in an import path is not a read
  const destructured = /const\s*\{([^}]*)\}\s*=\s*(?:ctx\.)?(?:config\.)?runtime\b/g;
  for (const match of text.matchAll(destructured)) {
    for (const part of (match[1] ?? '').split(',')) {
      const [key = '', alias] = part.split(':').map((piece) => piece.trim());
      if (!(SECTIONS as readonly string[]).includes(key)) continue;
      const use = new RegExp(`\\b${alias ?? key}\\.(?!(?:ts|js|mjs|json)\\b)([A-Za-z0-9_]+)`, 'g');
      for (const found of text.matchAll(use)) reads.add(`${key}.${found[1] ?? ''}`);
    }
  }
  return [...reads].sort();
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('configReadsIn', () => {
  it('finds the full path, the cfg form and the destructured form, and nothing else', () => {
    const text = [
      'const a = ctx.config.runtime.spool.pollMs;',
      'const b = cfg.lifecycle.sweepIntervalMs;',
      'const { health, lifecycle: life } = config.runtime;',
      'const c = health.backlogWarnMs + life.staleAfterSeconds;',
      'const d = report.receiving.hooks.status;',
      'const e = something.import.notAConfigRead;',
      "import { x } from '../query/health.ts';",
    ].join('\n');
    expect(configReadsIn(text)).toEqual([
      'health.backlogWarnMs',
      'lifecycle.staleAfterSeconds',
      'lifecycle.sweepIntervalMs',
      'spool.pollMs',
    ]);
  });

  it('finds a read of the projects section and flags a key of it that is not in the table', () => {
    const reads = configReadsIn('const a = config.runtime.projects.scope; const b = cfg.projects.bogusKey;');
    expect(reads).toEqual(['projects.bogusKey', 'projects.scope']);
    expect(reads.filter((key) => !TABLE.has(key))).toEqual(['projects.bogusKey']);
  });

  it('flags a key that is not in the table', () => {
    const reads = configReadsIn('const x = config.runtime.spool.bogusKey;');
    expect(reads.filter((key) => !TABLE.has(key))).toEqual(['spool.bogusKey']);
  });
});

describe('the keys read by the ingestion and lifecycle code', () => {
  const reads = new Map<string, string[]>();
  for (const folder of FOLDERS) {
    for (const file of sourcesUnder(path.join(SRC, folder))) {
      const found = configReadsIn(readFileSync(file, 'utf8'));
      if (found.length > 0) reads.set(path.relative(SRC, file).replaceAll('\\', '/'), found);
    }
  }

  it('the table of 02 1.2 is the shared catalogue of owner 02', () => {
    for (const key of [
      'spool.pollMs',
      'import.sliceMs',
      'ingest.queueMaxItems',
      'health.backlogWarnMs',
      'projects.scope',
      'projects.fullSweepIntervalMs',
    ]) {
      expect(TABLE.has(key), key).toBe(true);
    }
    expect([...TABLE].some((key) => key.startsWith('lifecycle.'))).toBe(true);
    expect([...TABLE].filter((key) => key.startsWith('projects.'))).toHaveLength(11);
  });

  it('finds the reads of the service, the sweeper and the health code (the scan is not vacuous)', () => {
    const all = new Set([...reads.values()].flat());
    for (const key of [
      'spool.pollMs',
      'import.sliceMs',
      'ingest.queueMaxItems',
      'lifecycle.registryPollMs',
      'lifecycle.sweepIntervalMs',
      'hooks.spoolWhileStoppedHours',
      'health.backlogWarnMs',
      'lifecycle.staleAfterSeconds',
    ]) {
      expect(all.has(key), key).toBe(true);
    }
  });

  it('every read is a key of the table', () => {
    const unknown = [...reads.entries()].flatMap(([file, keys]) =>
      keys.filter((key) => !TABLE.has(key)).map((key) => `${file}: ${key}`),
    );
    expect(unknown).toEqual([]);
  });
});
