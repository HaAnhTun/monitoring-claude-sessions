// T-AU-03: concurrent writers of the audit files (01 7.1, 7.3). Eight real processes append at the same moment; the
// result must hold one file header and every entry whole, with the task mutex taken by the writer itself or by the
// command around it. The children import the built `dist`, so the integration gate builds the runtime first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { hermeticEnv, killAllTracked, spawnTracked, useTempDirs } from '@mcs/testkit';
import { afterEach, describe, expect, it } from 'vitest';

import { entriesBetween } from '../src/audit/reader.ts';
import { resolveWorkspace } from '../src/workspace/paths.ts';

const makeTemp = useTempDirs();
const runtimeDir = fileURLToPath(new URL('../../../', import.meta.url));
const dist = (...parts: string[]): string => path.join(runtimeDir, 'packages', 'engine', 'dist', ...parts);
const BASE_MS = Date.UTC(2026, 9, 11, 14, 0, 0);

afterEach(async () => {
  await killAllTracked();
});

function builtUrl(file: string): string {
  if (!existsSync(file)) throw new Error(`${file} is missing: run the integration gate (it builds first)`);
  return pathToFileURL(file).href;
}

/** `kind` is `decision`, `change` or `locked-decision` (the command holds the task mutex around the writer). */
const CHILD = `
import { writeFileSync } from 'node:fs';
const [kind, writerUrl, pathsUrl, root, slug, startAt, index, resultFile] = process.argv.slice(2);
const { appendChange, appendDecision } = await import(writerUrl);
const { resolveWorkspace, withTaskMutex } = await import(pathsUrl);
const ws = resolveWorkspace(root, slug);
const i = Number(index);
const nowMs = Number(${BASE_MS}) + i * 1000;
const filler = 'x'.repeat(6000);
const write = () => kind === 'change'
  ? appendChange(ws, { action: 'configure', summary: 'change ' + i + ' ' + filler, reason: 'reason ' + i, files: ['config.json'], validation: 'schema ok (strict)', outcome: 'applied' }, nowMs)
  : appendDecision(ws, 'title ' + i, 'decision ' + i + ' ' + filler, 'rejected ' + i, nowMs);
let ok = false;
let message = null;
try {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < Number(startAt)) Atomics.wait(wait, 0, 0, 1);
  if (kind === 'locked-decision') await withTaskMutex(ws, write); else await write();
  ok = true;
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
writeFileSync(resultFile, JSON.stringify({ ok, message }));
process.exit(ok ? 0 : 1);
`;

function workspaceFolder(): { root: string; slug: string; dir: string } {
  const root = path.join(makeTemp('audit-int').path, 'tasks');
  const dir = path.join(root, 'shared');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'task.json'), '{"schema_version": 1, "id": "shared"}');
  return { root, slug: 'shared', dir };
}

async function runWriters(
  kinds: readonly ('decision' | 'change' | 'locked-decision')[],
  root: string,
  slug: string,
): Promise<void> {
  const scratch = makeTemp('audit-int-scratch').path;
  const script = path.join(scratch, 'child.mjs');
  writeFileSync(script, CHILD);
  const startAt = Date.now() + 3000;
  const children = kinds.map((kind, i) =>
    spawnTracked(
      process.execPath,
      [
        script,
        kind,
        builtUrl(dist('audit', 'writer.js')),
        builtUrl(dist('workspace', 'paths.js')),
        root,
        slug,
        String(startAt),
        String(i),
        path.join(scratch, `result-${String(i)}.json`),
      ],
      { env: hermeticEnv(scratch) },
    ),
  );
  const codes = await Promise.all(children.map((child) => child.exited));
  const failures = children
    .map((_child, i) => path.join(scratch, `result-${String(i)}.json`))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'))
    .filter((text) => text.includes('"ok":false'));
  expect(failures).toEqual([]);
  expect(codes).toEqual(kinds.map(() => 0));
}

const FILLER = 'x'.repeat(6000);

function decisionBlock(i: number): string {
  const ts = new Date(BASE_MS + i * 1000).toISOString().slice(0, 19) + 'Z';
  return `## ${ts} | title ${String(i)}\n- Decision: decision ${String(i)} ${FILLER}\n- Rejected alternatives: rejected ${String(i)}\n\n`;
}

function changeBlock(i: number): string {
  const ts = new Date(BASE_MS + i * 1000).toISOString().slice(0, 19) + 'Z';
  return (
    `## ${ts} | configure\n- Summary: change ${String(i)} ${FILLER}\n- Reason: reason ${String(i)}\n` +
    '- Files changed: config.json\n- Validation: schema ok (strict)\n- Outcome: applied\n- Unresolved: none\n\n'
  );
}

/** Splits a file into its header and blocks and requires that nothing else is in it. */
function parts(text: string, header: string): string[] {
  expect(text.startsWith(header)).toBe(true);
  expect(text.split(header)).toHaveLength(2);
  return text
    .slice(header.length)
    .split(/^(?=## )/m)
    .filter((block) => block !== '');
}

describe('T-AU-03: concurrent writers', () => {
  it('eight decide processes: eight whole entries, one header', async () => {
    const { root, slug, dir } = workspaceFolder();
    await runWriters(
      Array.from({ length: 8 }, () => 'decision' as const),
      root,
      slug,
    );
    const blocks = parts(readFileSync(path.join(dir, 'audit', 'decisions.md'), 'utf8'), '# Decisions\n\n');
    expect([...blocks].sort()).toEqual(Array.from({ length: 8 }, (_, i) => decisionBlock(i)).sort());
  });

  it('eight configure-style change entries: eight whole entries, one header', async () => {
    const { root, slug, dir } = workspaceFolder();
    await runWriters(
      Array.from({ length: 8 }, () => 'change' as const),
      root,
      slug,
    );
    const blocks = parts(readFileSync(path.join(dir, 'audit', 'changes.md'), 'utf8'), '# Changes\n\n');
    expect([...blocks].sort()).toEqual(Array.from({ length: 8 }, (_, i) => changeBlock(i)).sort());
  });

  it('both files at once, half of the decisions written by a command that already holds the task mutex', async () => {
    const { root, slug, dir } = workspaceFolder();
    const kinds = [
      'decision',
      'change',
      'locked-decision',
      'change',
      'decision',
      'change',
      'locked-decision',
      'change',
    ] as const;
    await runWriters(kinds, root, slug);
    const decisions = parts(readFileSync(path.join(dir, 'audit', 'decisions.md'), 'utf8'), '# Decisions\n\n');
    const changes = parts(readFileSync(path.join(dir, 'audit', 'changes.md'), 'utf8'), '# Changes\n\n');
    expect([...decisions].sort()).toEqual(
      kinds.flatMap((kind, i) => (kind === 'change' ? [] : [decisionBlock(i)])).sort(),
    );
    expect([...changes].sort()).toEqual(kinds.flatMap((kind, i) => (kind === 'change' ? [changeBlock(i)] : [])).sort());
  });

  it('the reader sees every entry the processes wrote', async () => {
    const { root, slug } = workspaceFolder();
    await runWriters(
      Array.from({ length: 8 }, () => 'decision' as const),
      root,
      slug,
    );
    const refs = await entriesBetween(resolveWorkspace(root, slug), BASE_MS, BASE_MS + 60_000, 20);
    expect(refs.map((r) => r.title)).toEqual(Array.from({ length: 8 }, (_, i) => `title ${String(7 - i)}`));
    expect(refs.every((r) => r.file === 'decisions' && r.summary.startsWith('decision '))).toBe(true);
  });
});
