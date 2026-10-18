// DA-T-API-2 and 01 section 2.9: the committed JSON Schemas and `docs/api/reference.md` equal what the one generator
// (`scripts/gen-schemas.mjs`) produces from the Zod schemas of `@mcs/shared`; a changed schema without regeneration fails.
// The generator runs in memory here (resolved to the sources through the `@mcs/source` condition, so no build is needed) and
// through its CLI on throw-away copies (`--root <dir>`), also from the sources.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as shared from '@mcs/shared';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error TS7016: repository scripts are plain .mjs files without declaration files
import * as generatorModule from '../../scripts/gen-schemas.mjs';

interface Generated {
  files: Map<string, string>;
  pending: string[];
}

interface ConfigEntry {
  file: string;
  source: string;
  io: 'input' | 'output';
}

interface Generator {
  SCHEMA_ID_PREFIX: string;
  GENERATED_MARKER: string;
  REFERENCE_FILE: string;
  CONFIG_SCHEMAS: ConfigEntry[];
  generateAll(namespace: object): Generated;
  compareFiles(files: Map<string, string>, root: string): string[];
  writeFiles(files: Map<string, string>, root: string): void;
}

const generator = generatorModule as unknown as Generator;

const RUNTIME = join(import.meta.dirname, '..', '..');
const SKILL = join(RUNTIME, '..');
const GENERATOR_SCRIPT = join(RUNTIME, 'scripts', 'gen-schemas.mjs');

const generated = generator.generateAll(shared);

describe('generateAll', () => {
  it('writes a file per config schema whose source is exported, and reports the others as pending', () => {
    const exported = (name: string) => Object.hasOwn(shared, name);
    for (const entry of generator.CONFIG_SCHEMAS) {
      expect(generated.files.has(`schemas/${entry.file}`), entry.file).toBe(exported(entry.source));
    }
    expect(generated.pending.filter((line) => line.startsWith('schemas/') && line.includes('.v1.schema.json'))).toEqual(
      generator.CONFIG_SCHEMAS.filter((entry) => !exported(entry.source)).map(
        (entry) => `schemas/${entry.file} (${entry.source} is not exported by @mcs/shared yet)`,
      ),
    );
    for (const name of ['instance', 'state', 'runtime', 'backup-manifest', 'cli-envelope']) {
      expect(generated.files.has(`schemas/${name}.v1.schema.json`), name).toBe(true);
    }
  });

  it('writes one schema per non-null route part, the stream, one per export line type and the reference', () => {
    const expected = new Set<string>(['schemas/api/stream.schema.json', generator.REFERENCE_FILE]);
    for (const route of Object.values(shared.routes)) {
      for (const part of ['params', 'query', 'body', 'response'] as const) {
        if (route[part] !== null) expected.add(`schemas/api/${route.id}.${part}.schema.json`);
      }
    }
    for (const type of Object.keys(shared.ExportLineSchemas)) expected.add(`schemas/export/${type}.schema.json`);
    for (const entry of generator.CONFIG_SCHEMAS) {
      if (Object.hasOwn(shared, entry.source)) expected.add(`schemas/${entry.file}`);
    }
    expect([...generated.files.keys()].sort()).toEqual([...expected].sort());
  });

  it('is deterministic: two runs give the same bytes', () => {
    const again = generator.generateAll(shared);
    expect([...again.files.entries()]).toEqual([...generated.files.entries()]);
  });

  it('gives every schema the draft, the $id of registry 9.3, the generated marker and the JSON layout of 01 2.9', () => {
    for (const [path, content] of generated.files) {
      if (!path.endsWith('.schema.json')) continue;
      const json = JSON.parse(content) as Record<string, unknown>;
      expect(json['$schema'], path).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(json['$id'], path).toBe(`${generator.SCHEMA_ID_PREFIX}${path.slice('schemas/'.length)}`);
      expect(json['$comment'], path).toBe(generator.GENERATED_MARKER);
      expect(String(json['$comment']), path).toContain('generated; do not edit');
      expect(typeof json['title'], path).toBe('string');
      expect(typeof json['description'], path).toBe('string');
      expect(Object.keys(json).slice(0, 5), path).toEqual(['$schema', '$id', '$comment', 'title', 'description']);
      expect(content, path).toBe(`${JSON.stringify(json, null, 2)}\n`);
    }
  });

  it('has no config.json schema (docs/configuration.md describes it, with JavaScript regex syntax) and no schema says Python', () => {
    expect(generator.CONFIG_SCHEMAS.map((entry) => entry.file)).not.toContain('config.v1.schema.json');
    expect(generated.files.has('schemas/config.v1.schema.json')).toBe(false);
    for (const entry of generator.CONFIG_SCHEMAS) expect(entry.description, entry.file).not.toMatch(/python/i);
    for (const [path, content] of generated.files) expect(content, path).not.toContain('Python syntax');
  });

  it('reports no pending schema except the diagnostics bundle, whose source WP-22 exports', () => {
    expect(generated.pending.filter((line) => !line.includes('DiagnosticsBundleSchema'))).toEqual([]);
    if (Object.hasOwn(shared, 'DiagnosticsBundleSchema')) expect(generated.pending).toEqual([]);
  });

  it('describes a route params schema with exactly the :names of its path, all required', () => {
    for (const route of Object.values(shared.routes)) {
      const text = generated.files.get(`schemas/api/${route.id}.params.schema.json`);
      if (route.params === null) {
        expect(text, route.id).toBeUndefined();
        continue;
      }
      const names = [...route.path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '').sort();
      const json = JSON.parse(text ?? '{}') as { properties?: Record<string, unknown>; required?: string[] };
      expect(Object.keys(json.properties ?? {}).sort(), route.id).toEqual(names);
      expect([...(json.required ?? [])].sort(), route.id).toEqual(names);
    }
  });

  it('writes a reference that lists every route and links only to files that exist', () => {
    const reference = generated.files.get(generator.REFERENCE_FILE) ?? '';
    expect(reference.startsWith('<!-- Generated by runtime/scripts/gen-schemas.mjs')).toBe(true);
    expect(reference).toContain('generated; do not edit');
    for (const route of Object.values(shared.routes)) {
      expect(reference, route.id).toContain(`## ${route.id}`);
      expect(reference, route.id).toContain(`\`${route.method} ${route.path}\``);
    }
    for (const code of shared.COMMON_ERROR_CODES) expect(reference, code).toContain(`\`${code}\``);
    const links = [...reference.matchAll(/\]\(\.\.\/\.\.\/(schemas\/[^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThan(Object.keys(shared.routes).length);
    for (const link of links) expect(generated.files.has(link), link).toBe(true);
  });
});

describe('committed files (DA-T-API-2)', () => {
  it('are identical to the generated ones', () => {
    expect(generator.compareFiles(generated.files, SKILL)).toEqual([]);
  });

  it('detect a changed, a missing and a stale file', () => {
    const copy = mkdtempSync(join(tmpdir(), 'mcs-schemas-drift-'));
    try {
      generator.writeFiles(generated.files, copy);
      expect(generator.compareFiles(generated.files, copy)).toEqual([]);
      const changed = join(copy, 'schemas', 'instance.v1.schema.json');
      writeFileSync(changed, `${readFileSync(changed, 'utf8')} `);
      rmSync(join(copy, 'schemas', 'api', 'health.response.schema.json'));
      writeFileSync(join(copy, 'schemas', 'api', 'retired.response.schema.json'), '{}\n');
      expect(generator.compareFiles(generated.files, copy)).toEqual([
        'changed: schemas/instance.v1.schema.json',
        'missing: schemas/api/health.response.schema.json',
        'stale: schemas/api/retired.response.schema.json',
      ]);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('scripts/gen-schemas.mjs CLI (from the sources, on throw-away copies)', () => {
  const folders: string[] = [];

  afterEach(() => {
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-schemas-cli-'));
    folders.push(dir);
    return dir;
  }

  function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
    const home = temp();
    const result = spawnSync(process.execPath, ['--conditions=@mcs/source', GENERATOR_SCRIPT, ...args], {
      cwd: RUNTIME,
      encoding: 'utf8',
      env: { ...process.env, MCS_HOME: home, CLAUDE_CONFIG_DIR: home, MCS_HOOK_DISABLE: '1' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('writes every file below --root, then --check passes', () => {
    const root = temp();
    const written = run(['--root', root]);
    expect(written.stderr).toBe('');
    expect(written.status).toBe(0);
    expect(written.stdout).toContain(`gen-schemas: wrote ${generated.files.size} files`);
    for (const path of generated.files.keys()) expect(existsSync(join(root, ...path.split('/'))), path).toBe(true);
    const checked = run(['--check', '--root', root]);
    expect(checked.stderr).toBe('');
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain(`${generated.files.size} files identical`);
  });

  it('--check exits 1 and names the file when a schema changed without regeneration', () => {
    const root = temp();
    expect(run(['--root', root]).status).toBe(0);
    const file = join(root, 'schemas', 'api', 'health.response.schema.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"type": "object"', '"type": "array"'));
    const checked = run(['--check', '--root', root]);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('gen-schemas: changed: schemas/api/health.response.schema.json');
    expect(checked.stderr).toContain('1 file(s) differ');
  });

  it('--check on the committed files passes', () => {
    const checked = run(['--check']);
    expect(checked.stderr).toBe('');
    expect(checked.status).toBe(0);
  });

  it('--check reports a missing reference and a stale schema, and a rewrite removes the stale one', () => {
    const root = temp();
    expect(run(['--root', root]).status).toBe(0);
    rmSync(join(root, 'docs', 'api', 'reference.md'));
    mkdirSync(join(root, 'schemas', 'api'), { recursive: true });
    writeFileSync(join(root, 'schemas', 'api', 'retired.query.schema.json'), '{}\n');
    const checked = run(['--check', '--root', root]);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('gen-schemas: missing: docs/api/reference.md');
    expect(checked.stderr).toContain('gen-schemas: stale: schemas/api/retired.query.schema.json');
    expect(run(['--root', root]).status).toBe(0);
    expect(existsSync(join(root, 'schemas', 'api', 'retired.query.schema.json'))).toBe(false);
    expect(run(['--check', '--root', root]).status).toBe(0);
  });

  it('--no-pending fails exactly while a schema source is not exported yet', () => {
    const root = temp();
    const result = run(['--no-pending', '--root', root]);
    expect(result.status).toBe(generated.pending.length > 0 ? 1 : 0);
    for (const line of generated.pending) expect(result.stdout).toContain(`gen-schemas: pending ${line}`);
  });

  it('rejects unknown arguments with exit 2 and writes nothing', () => {
    const root = temp();
    const result = run(['--frobnicate', '--root', root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/gen-schemas.mjs');
    expect(existsSync(join(root, 'schemas'))).toBe(false);
    expect(run(['--root']).status).toBe(2);
  });
});
