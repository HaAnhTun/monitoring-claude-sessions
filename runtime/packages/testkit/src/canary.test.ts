import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CANARY, scanForCanaries } from './canary.ts';
import { useTempDirs } from './temp.ts';

const tempDir = useTempDirs();

describe('CANARY', () => {
  it('has the seven kinds of 05 4.10, all distinct and labelled FIXTURE', () => {
    expect(Object.keys(CANARY).sort()).toEqual(
      ['attachment', 'envToken', 'key', 'prompt', 'query', 'thinking', 'toolResult'].sort(),
    );
    const values = Object.values(CANARY);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value.startsWith('FIXTURE')).toBe(true);
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value.length).toBeGreaterThanOrEqual(24);
    }
  });

  it('is not a substring of another canary (a hit identifies exactly one kind)', () => {
    const entries = Object.entries(CANARY);
    for (const [a, va] of entries) {
      for (const [b, vb] of entries) {
        if (a !== b) expect(va.includes(vb), `${a} contains ${b}`).toBe(false);
      }
    }
  });
});

describe('scanForCanaries', () => {
  it('reports each file and canary kind that is present', () => {
    const dir = tempDir('canary').path;
    writeFileSync(join(dir, 'a.log'), `line ${CANARY.prompt} and ${CANARY.query}\n`);
    writeFileSync(join(dir, 'b.log'), 'clean');
    const hits = scanForCanaries([join(dir, 'a.log'), join(dir, 'b.log')], []);
    expect(hits).toEqual([
      { file: join(dir, 'a.log'), canary: 'prompt' },
      { file: join(dir, 'a.log'), canary: 'query' },
    ]);
  });

  it('skips the canaries that are allowed in that place', () => {
    const dir = tempDir('canary2').path;
    writeFileSync(join(dir, 'a.log'), `${CANARY.prompt} ${CANARY.toolResult}`);
    expect(scanForCanaries([join(dir, 'a.log')], ['prompt'])).toEqual([
      { file: join(dir, 'a.log'), canary: 'toolResult' },
    ]);
    expect(scanForCanaries([join(dir, 'a.log')], ['prompt', 'toolResult'])).toEqual([]);
  });

  it('walks folders recursively and finds canaries in binary files', () => {
    const dir = tempDir('canary3').path;
    mkdirSync(join(dir, 'x', 'y'), { recursive: true });
    writeFileSync(join(dir, 'x', 'y', 'blob.bin'), Buffer.concat([Buffer.from([0, 255, 0]), Buffer.from(CANARY.key)]));
    writeFileSync(join(dir, 'x', 'ok.txt'), 'nothing here');
    expect(scanForCanaries([dir], [])).toEqual([{ file: join(dir, 'x', 'y', 'blob.bin'), canary: 'key' }]);
  });

  it('returns nothing for clean input and fails loudly for a missing path', () => {
    const dir = tempDir('canary4').path;
    writeFileSync(join(dir, 'a'), 'clean');
    expect(scanForCanaries([dir], [])).toEqual([]);
    expect(() => scanForCanaries([join(dir, 'missing')], [])).toThrow(/missing/);
  });
});

describe('testkit source hygiene', () => {
  const sources = readdirSync(import.meta.dirname)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(import.meta.dirname, name), 'utf8') }));

  it('never reads the real home or the real Claude folder', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/homedir\s*\(/);
      expect(text, name).not.toMatch(/process\.env\[?\.?\s*['"]?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\b/);
      expect(text, name).not.toMatch(/['"`]~[/\\]\.claude/);
    }
  });

  it('has no findFreePort, shell spawns, Math.random or sleeps', () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/findFreePort/);
      expect(text, name).not.toMatch(/shell\s*:\s*true/);
      expect(text, name).not.toMatch(/(?<![.\w])(exec|execSync)\s*\(/);
      expect(text, name).not.toMatch(/Math\.random/);
    }
  });
});
