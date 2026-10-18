// Offline re-check of the plugin, marketplace and skill-folder rules of ADR 0061 and 0062 (the verifier also runs
// `claude plugin validate --strict` when the CLI is available).
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const RUNTIME = join(REPO, 'runtime');
const SKILL_NAME = 'monitoring-claude-sessions';
const SKILLDIR = join(REPO, 'skills', SKILL_NAME);

/** Files `SKILL.md` may reference before the work packages that create them land (none left since the launcher, WP-21). */
const PENDING: readonly string[] = [];

/** The fixed top-level file set of the committed bundle (ADR 0062 item 1, ADR 0063). */
const BUNDLE_ENTRIES = [
  '.mcs-build.json',
  'THIRD-PARTY-NOTICES.txt',
  'mcs-cli.mjs',
  'mcs-hook.mjs',
  'mcs-server.mjs',
  'migrations',
  'web',
];

/** The documented top-level entries of the skill folder (ADR 0062 item 1). */
const SKILLDIR_ENTRIES = ['SKILL.md', 'config', 'runtime', 'scripts', 'bundle', 'reference'];

/** The commands `mcs help` lists; `SKILL.md` may teach only these. */
const CLI_COMMANDS = [
  'discover',
  'init',
  'init-task',
  'inspect',
  'configure',
  'decide',
  'audit',
  'check',
  'version',
  'help',
  'start',
  'stop',
  'status',
  'restart',
  'verify',
  'serve',
  'instances',
  'doctor',
  'migrate-workspace',
];

const PLUGIN_KEYS = ['name', 'displayName', 'version', 'description', 'author', 'repository', 'license', 'keywords'];
const RESERVED_PREFIXES = ['claude-', 'anthropic-'];
const RESERVED_WORDS = ['claude', 'anthropic'];
const RESERVED_MARKETPLACES = [
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
];
// Assembled at run time so this file itself holds none of the old-engine markers (the Python-free guard).
const OLD_ENGINE_MARKERS = [
  ['viewer', 'py'].join('.'),
  ['', 'api', 'sessions'].join('/'),
  ['', 'api', 'task'].join('/'),
  ['py', 'thon'].join(''),
  ['py', 'thon3'].join(''),
  ['py', ' -3'].join(''),
];

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function isKebab(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

function hasReservedName(name: string): boolean {
  const words = name.split(/[-_.]/);
  return RESERVED_PREFIXES.some((p) => name.startsWith(p)) || RESERVED_WORDS.some((w) => words.includes(w));
}

const plugin = readJson(join(REPO, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(join(REPO, '.claude-plugin', 'marketplace.json'));
const runtimeVersion = readJson(join(RUNTIME, 'package.json'))['version'];

describe('plugin.json', () => {
  it('has only the documented keys and no component key', () => {
    for (const key of Object.keys(plugin)) expect(PLUGIN_KEYS, `unexpected key ${key}`).toContain(key);
    expect(plugin['name']).toBe('session-monitor');
  });

  it('ships no hooks and no MCP registration', () => {
    for (const dir of [REPO, SKILLDIR]) {
      expect(existsSync(join(dir, 'hooks', 'hooks.json')), `${dir}/hooks/hooks.json`).toBe(false);
      expect(existsSync(join(dir, '.mcp.json')), `${dir}/.mcp.json`).toBe(false);
    }
  });

  it('has a kebab-case name without reserved prefixes or words', () => {
    const name = plugin['name'] as string;
    expect(isKebab(name)).toBe(true);
    expect(hasReservedName(name)).toBe(false);
  });

  it('carries the version of runtime/package.json', () => {
    expect(plugin['version']).toBe(runtimeVersion);
  });
});

describe('marketplace.json', () => {
  it('has a valid name and an owner', () => {
    const name = marketplace['name'] as string;
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(RESERVED_MARKETPLACES).not.toContain(name);
    expect(hasReservedName(name)).toBe(false);
    const owner = marketplace['owner'] as { name?: unknown } | undefined;
    expect(typeof owner?.name).toBe('string');
  });

  it('lists exactly the plugin, from the skill folder, at the plugin version', () => {
    const plugins = marketplace['plugins'] as Record<string, unknown>[];
    expect(plugins).toHaveLength(1);
    const entry = plugins[0]!;
    expect(entry['name']).toBe(plugin['name']);
    const source = entry['source'] as string;
    expect(source.startsWith('./')).toBe(true);
    expect(source.split('/')).not.toContain('..');
    expect(source).not.toContain('\\');
    expect(existsSync(join(REPO, source, 'SKILL.md'))).toBe(true);
    expect(resolve(REPO, source)).toBe(SKILLDIR);
    expect(entry['version']).toBe(plugin['version']);
  });
});

describe('SKILL.md', () => {
  const text = readFileSync(join(SKILLDIR, 'SKILL.md'), 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const frontmatter = match?.[1] ?? '';
  const body = match?.[2] ?? '';
  const field = (key: string): string | undefined =>
    new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter)?.[1]?.trim();

  it('has frontmatter whose name is the folder name and a short enough description', () => {
    expect(match).not.toBeNull();
    expect(field('name')).toBe(SKILL_NAME);
    const description = field('description') ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length + (field('when_to_use') ?? '').length).toBeLessThanOrEqual(1536);
  });

  it('keeps the body under 500 lines', () => {
    expect(body.split('\n').length).toBeLessThan(500);
  });

  it('references files only through ${CLAUDE_SKILL_DIR}, inside the folder, and they exist', () => {
    const refs = [...text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^\s"`'<>)]+)/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.split('/'), ref).not.toContain('..');
      if (PENDING.some((p) => ref === p || (p.endsWith('/') && ref.startsWith(p)))) continue;
      expect(existsSync(join(SKILLDIR, ref)), ref).toBe(true);
    }
    expect(text).not.toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(text.split(/[\s/"`'()]/)).not.toContain('..');
  });

  it('holds none of the old-engine markers', () => {
    for (const marker of OLD_ENGINE_MARKERS) expect(text.toLowerCase(), marker).not.toContain(marker);
  });

  it('teaches only commands the CLI lists', () => {
    const taught = [...text.matchAll(/\$MCS ([a-z][a-z-]*)/g)].map((m) => m[1] ?? '');
    expect(taught.length).toBeGreaterThan(0);
    for (const command of taught) expect(CLI_COMMANDS, command).toContain(command);
  });
});

describe('skill folder', () => {
  it('holds no symlink and only its documented top-level entries', () => {
    for (const entry of readdirSync(SKILLDIR)) expect(SKILLDIR_ENTRIES, entry).toContain(entry);
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = lstatSync(full);
        expect(stat.isSymbolicLink(), full).toBe(false);
        if (stat.isDirectory()) walk(full);
      }
    };
    walk(SKILLDIR);
  });

  it('holds the only copies of config/defaults.json and reference/transcript-format.md (the root originals are gone)', () => {
    for (const file of ['config/defaults.json', 'reference/transcript-format.md']) {
      expect(existsSync(join(SKILLDIR, file)), file).toBe(true);
      expect(existsSync(join(REPO, file)), file).toBe(false);
    }
    expect(existsSync(join(REPO, 'config'))).toBe(false);
    expect(existsSync(join(REPO, 'reference'))).toBe(false);
  });

  it('holds the skill-level runtime defaults', () => {
    expect(readJson(join(SKILLDIR, 'runtime', 'defaults.json'))).toEqual({ schema_version: 1 });
  });

  it('holds the committed bundle: the fixed file set, the web index and a manifest that lists every other file', () => {
    const bundle = join(SKILLDIR, 'bundle');
    expect(readdirSync(bundle).sort()).toEqual(BUNDLE_ENTRIES);
    expect(existsSync(join(bundle, 'web', 'index.html'))).toBe(true);
    expect(readdirSync(join(bundle, 'migrations')).every((name) => name.endsWith('.sql'))).toBe(true);
    const files: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (lstatSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
        else files.push(`${prefix}${entry}`);
      }
    };
    walk(bundle, '');
    const manifest = readJson(join(bundle, '.mcs-build.json'));
    expect(manifest['schemaVersion']).toBe(1);
    expect(manifest['runtimeVersion']).toBe(runtimeVersion);
    expect(Object.keys(manifest['files'] as Record<string, unknown>)).toEqual(
      files.filter((rel) => rel !== '.mcs-build.json').sort(),
    );
  });
});
