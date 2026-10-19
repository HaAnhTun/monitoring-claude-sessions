// Config key coverage (WP-105): every key that validation accepts is classified, a `supported` key is read by the file that is
// named for it, and the warnings of `configKeyWarnings` are what `mcs doctor` prints.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultSkillDir, loadSkillDefaults, parseLegacyConfig, type LegacyConfig } from './defaults.ts';
import { configKeyWarnings, CONFIG_KEY_SUPPORT, type ConfigKeyWarning } from './key-support.ts';
import { toPlain } from '../json/index.ts';
import { LEGACY_KEYS } from './validate-legacy.ts';

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));
const CONTAINERS = ['panels', 'ui', 'poll', 'limits'] as const;
/** The keys inside `attempts`, which is null in the shipped defaults (`AttemptsSchema`). */
const ATTEMPTS_KEYS = ['start', 'end', 'label_prefix', 'time_format'];
/** Nothing was set by the task itself: the rules that fire on a default alone stay quiet. */
const NOTHING_SET = { explicit: new Set<string>() };

async function shippedDefaults(): Promise<LegacyConfig> {
  const loaded = await loadSkillDefaults(defaultSkillDir());
  return parseLegacyConfig(toPlain(loaded.doc));
}

function codes(warnings: readonly ConfigKeyWarning[]): string[] {
  return warnings.map((w) => `${w.code} ${w.key}`);
}

describe('the key table is complete', () => {
  it('classifies every key that validation accepts and every top-level key of the shipped defaults', async () => {
    const defaults = await shippedDefaults();
    const top = Object.keys(CONFIG_KEY_SUPPORT).filter((key) => !key.includes('.'));
    expect(top.sort()).toEqual([...LEGACY_KEYS].sort());
    expect(Object.keys(defaults).sort()).toEqual([...LEGACY_KEYS].sort());
  });

  it('names only keys that exist: nested keys are in the shipped defaults, attempts keys in the attempts schema', async () => {
    const defaults = await shippedDefaults();
    for (const key of Object.keys(CONFIG_KEY_SUPPORT)) {
      const [parent, child] = key.split('.');
      if (child === undefined) continue;
      if (parent === 'attempts') {
        expect(ATTEMPTS_KEYS, key).toContain(child);
        continue;
      }
      expect(CONTAINERS as readonly (string | undefined)[], key).toContain(parent);
      const section = defaults[parent as (typeof CONTAINERS)[number]] as Record<string, unknown>;
      expect(Object.keys(section), key).toContain(child);
    }
  });

  it('lists every nested key of the shipped defaults, so a new one cannot be added unclassified', async () => {
    const defaults = await shippedDefaults();
    for (const parent of CONTAINERS) {
      for (const child of Object.keys(defaults[parent])) {
        expect(CONFIG_KEY_SUPPORT, `${parent}.${child}`).toHaveProperty([`${parent}.${child}`]);
      }
    }
    for (const child of ATTEMPTS_KEYS) expect(CONFIG_KEY_SUPPORT).toHaveProperty([`attempts.${child}`]);
  });

  it('gives every unsupported key its shipped default and a reason, and no consumer', async () => {
    const defaults = await shippedDefaults();
    const unsupported = Object.entries(CONFIG_KEY_SUPPORT).filter(([, v]) => v.status === 'unsupported');
    expect(unsupported.map(([k]) => k).sort()).toEqual(['limits.max_events', 'limits.usage_scan_budget_ms']);
    for (const [key, entry] of unsupported) {
      const [parent, child] = key.split('.') as ['limits', string];
      expect(entry.consumers).toEqual([]);
      expect(entry.note.length).toBeGreaterThan(10);
      expect(entry.defaultValue, key).toBe(defaults[parent][child]);
    }
  });
});

describe('the consumers', () => {
  it('names, for every supported or partial key, existing source files that hold the last segment of the key', () => {
    for (const [key, entry] of Object.entries(CONFIG_KEY_SUPPORT)) {
      if (entry.status === 'unsupported') continue;
      expect(entry.consumers.length, key).toBeGreaterThan(0);
      const token = new RegExp(`\\b${key.split('.').pop() ?? key}\\b`);
      let found = false;
      for (const consumer of entry.consumers) {
        expect(consumer, key).toMatch(/^(engine|server|shared)\/src\/.+\.ts$/);
        expect(consumer, key).not.toMatch(/\.test\.ts$/);
        const text = readFileSync(`${PACKAGES}${consumer}`, 'utf8');
        if (token.test(text)) found = true;
      }
      expect(found, `${key} is not mentioned in ${entry.consumers.join(', ')}`).toBe(true);
    }
  });

  it('the two unsupported keys really have no consumer in the engine, server or shared sources', () => {
    for (const token of ['max_events', 'usage_scan_budget_ms', 'maxEvents', 'usageScanBudgetMs']) {
      const hits = Object.values(sourceFiles()).filter((text) => text.includes(token));
      expect(hits.length, token).toBe(0);
    }
  });
});

/** Production sources of the three packages that could read a key, without the tests and this table. */
function sourceFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of listSources(`${PACKAGES}engine/src`)
    .concat(listSources(`${PACKAGES}server/src`))
    .concat(listSources(`${PACKAGES}shared/src`))) {
    if (file.endsWith('.test.ts') || file.endsWith('key-support.ts')) continue;
    out[file] = readFileSync(file, 'utf8');
  }
  return out;
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('configKeyWarnings', () => {
  it('gives no warning for the shipped defaults, and none when the task set nothing itself', async () => {
    const defaults = await shippedDefaults();
    expect(configKeyWarnings(defaults, NOTHING_SET)).toEqual([]);
  });

  it('says that the two unsupported limits do nothing once they differ from the default', async () => {
    const defaults = await shippedDefaults();
    const warnings = configKeyWarnings(
      { ...defaults, limits: { ...defaults.limits, max_events: 100, usage_scan_budget_ms: 50 } },
      NOTHING_SET,
    );
    expect(codes(warnings)).toEqual([
      'CONFIG_KEY_UNSUPPORTED limits.max_events',
      'CONFIG_KEY_UNSUPPORTED limits.usage_scan_budget_ms',
    ]);
    expect(warnings[0]?.message).toContain('timeline is paged');
    expect(warnings[1]?.message).toContain('incrementally');
    const same = configKeyWarnings({ ...defaults, limits: { ...defaults.limits, max_events: 20000 } }, NOTHING_SET);
    expect(same).toEqual([]);
  });

  it('never prints a configured value', async () => {
    const defaults = await shippedDefaults();
    const warnings = configKeyWarnings(
      {
        ...defaults,
        limits: { ...defaults.limits, max_events: 777123, usage_scan_budget_ms: 888456 },
        poll: { ...defaults.poll, unknown: 424242 },
      },
      NOTHING_SET,
    );
    expect(warnings.length).toBe(3);
    for (const w of warnings) expect(w.message).not.toMatch(/777123|888456|424242/);
  });

  it('reports unknown keys inside poll, panels, ui, limits and attempts, and at the top level', async () => {
    const defaults = await shippedDefaults();
    const warnings = configKeyWarnings(
      {
        ...defaults,
        poll: { ...defaults.poll, unknown: 1 },
        panels: { ...defaults.panels, unknown: true },
        ui: { ...defaults.ui, flag: true },
        limits: { ...defaults.limits, extra: 2 },
        attempts: { start: 'a', end: 'b', surprise: 'x' },
        chain_log: 'chain.log',
        extra_key: 1,
      },
      NOTHING_SET,
    );
    expect(codes(warnings).sort()).toEqual(
      [
        'CONFIG_KEY_UNKNOWN attempts.surprise',
        'CONFIG_KEY_UNKNOWN extra_key',
        'CONFIG_KEY_UNKNOWN limits.extra',
        'CONFIG_KEY_UNKNOWN panels.unknown',
        'CONFIG_KEY_UNKNOWN poll.unknown',
        'CONFIG_KEY_UNKNOWN ui.flag',
      ].sort(),
    );
  });

  it('writes an unknown key as printable text, clipped', async () => {
    const defaults = await shippedDefaults();
    const odd = `bad${String.fromCharCode(10)}key${'x'.repeat(200)}`;
    const warnings = configKeyWarnings({ ...defaults, poll: { ...defaults.poll, [odd]: 1 } }, NOTHING_SET);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).not.toContain(String.fromCharCode(10));
    expect(warnings[0]?.key.length).toBeLessThan(80);
  });

  describe('keys that do nothing because a partner is missing', () => {
    async function withPanels(
      panels: Record<string, boolean>,
      rest: Partial<LegacyConfig> = {},
    ): Promise<ConfigKeyWarning[]> {
      const defaults = await shippedDefaults();
      return configKeyWarnings({ ...defaults, panels: { ...defaults.panels, logs: false, ...panels }, ...rest });
    }

    it('panels.attempts without attempts', async () => {
      expect(codes(await withPanels({ attempts: true }))).toEqual(['CONFIG_KEY_INERT panels.attempts']);
    });

    it('panels.chain_log without chain_log', async () => {
      expect(codes(await withPanels({ chain_log: true }))).toEqual(['CONFIG_KEY_INERT panels.chain_log']);
    });

    it('panels.ledger without ledger', async () => {
      expect(codes(await withPanels({ ledger: true }))).toEqual(['CONFIG_KEY_INERT panels.ledger']);
    });

    it('panels.logs without live_log_globs, unless the task never set panels.logs itself', async () => {
      const defaults = await shippedDefaults();
      expect(codes(configKeyWarnings(defaults))).toEqual(['CONFIG_KEY_INERT panels.logs']);
      expect(configKeyWarnings(defaults, { explicit: new Set(['title']) })).toEqual([]);
      expect(codes(configKeyWarnings(defaults, { explicit: new Set(['panels.logs']) }))).toEqual([
        'CONFIG_KEY_INERT panels.logs',
      ]);
      expect(configKeyWarnings({ ...defaults, live_log_globs: ['logs/*.log'] })).toEqual([]);
    });

    it('attempts without chain_log', async () => {
      const warnings = await withPanels({}, { attempts: { start: 'a', end: 'b' }, chain_log: null });
      expect(codes(warnings)).toEqual(['CONFIG_KEY_INERT attempts']);
    });

    it('stop_file with the git panel off', async () => {
      const warnings = await withPanels({ git: false, logs: false }, { stop_file: 'STOP' });
      expect(codes(warnings)).toEqual(['CONFIG_KEY_INERT stop_file']);
      expect(await withPanels({}, { stop_file: 'STOP' })).toEqual([]);
    });

    it('docker and watched_processes with the machine panel off', async () => {
      const warnings = await withPanels({ machine: false, logs: false });
      expect(codes(warnings)).toEqual(['CONFIG_KEY_INERT docker', 'CONFIG_KEY_INERT watched_processes']);
      const quiet = await withPanels({ machine: false, logs: false }, { docker: false, watched_processes: [] });
      expect(quiet).toEqual([]);
      const defaults = await shippedDefaults();
      const notSetByTask = configKeyWarnings(
        { ...defaults, panels: { ...defaults.panels, machine: false, logs: false } },
        { explicit: new Set(['panels.machine']) },
      );
      expect(notSetByTask).toEqual([]);
    });
  });

  it('gives no warning for a configuration shaped like a chain task', async () => {
    const defaults = await shippedDefaults();
    const chain: LegacyConfig = {
      ...defaults,
      title: 'Chain task',
      window_hours: 30,
      session_rules: [{ match: '^chain-(\\d+)$', label: 'step {1}' }],
      panels: { machine: true, git: true, logs: true, ledger: true, chain_log: true, attempts: true },
      live_log_globs: ['logs/*.log'],
      chain_log: 'logs/chain.log',
      ledger: 'LEDGER.md',
      stop_file: 'STOP',
      attempts: {
        start: '^start (?<name>.+)$',
        end: '^end (?<name>.+)$',
        label_prefix: 'run ',
        time_format: '%H:%M:%S',
      },
    };
    expect(configKeyWarnings(chain)).toEqual([]);
  });

  it('is a pure function: the input is not changed and the same input gives the same answer', async () => {
    const defaults = await shippedDefaults();
    const input = { ...defaults, limits: { ...defaults.limits, max_events: 5 } };
    const before = JSON.stringify(input);
    expect(configKeyWarnings(input)).toEqual(configKeyWarnings(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});
