// The pure parts of the ingest service (02 4.10): the error of `untilIdle`, and the mapping of the resolved configuration onto the
// lifecycle thresholds, the import settings and the session rules. The service over a real workspace is in
// `packages/engine/test/ingest-service.int.test.ts`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { defaultSkillDir } from '../config/defaults.ts';
import { resolveConfig, type ResolvedConfig } from '../config/resolve.ts';
import { DEFAULT_LIFECYCLE_CFG } from '../lifecycle/facts.ts';
import { DEFAULT_IMPORT_SETTINGS } from './transcripts/importer.ts';
import {
  IngestIdleTimeoutError,
  importSettingsOf,
  lifecycleCfgOf,
  sessionRulesOf,
  type IngestStats,
} from './service.ts';

const tempDir = useTempDirs();
const SHIPPED_DEFAULTS = readFileSync(path.join(defaultSkillDir(), 'config', 'defaults.json'), 'utf8');

/** The configuration of a skill folder whose `runtime/defaults.json` holds `runtimeDefaults`. */
async function configOf(runtimeDefaults: Record<string, unknown> = {}): Promise<ResolvedConfig> {
  const skill = tempDir('ingest-service-unit').path;
  mkdirSync(path.join(skill, 'config'), { recursive: true });
  mkdirSync(path.join(skill, 'runtime'), { recursive: true });
  writeFileSync(path.join(skill, 'config', 'defaults.json'), SHIPPED_DEFAULTS);
  writeFileSync(
    path.join(skill, 'runtime', 'defaults.json'),
    JSON.stringify({ schema_version: 1, ...runtimeDefaults }),
  );
  return resolveConfig({ workspace: null, env: {}, cli: {}, skillDir: skill });
}

const STATS: IngestStats = {
  queued: 3,
  queuedBytes: 600,
  lastCommitAt: 1,
  failures: 0,
  spoolBytesBehind: 10,
  transcriptBytesBehind: 20,
  backfillRemainingBytes: 30,
  filesTracked: 2,
};

describe('IngestIdleTimeoutError', () => {
  it('is an Error that carries what was pending and is recognised by its name', () => {
    const error = new IngestIdleTimeoutError(STATS);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('IngestIdleTimeoutError');
    expect(error.pending).toEqual(STATS);
    expect(error.message).toMatch(/idle/);
  });
});

describe('lifecycleCfgOf', () => {
  it('gives the defaults of 02 7.8 for the shipped configuration', async () => {
    expect(lifecycleCfgOf(await configOf())).toEqual(DEFAULT_LIFECYCLE_CFG);
  });

  it('takes a threshold from the runtime configuration and the legacy keys for the derived ones', async () => {
    const cfg = lifecycleCfgOf(await configOf({ lifecycle: { sweepIntervalMs: 1234, staleAfterSeconds: 600 } }));
    expect(cfg).toMatchObject({
      sweepIntervalMs: 1234,
      staleAfterSeconds: 600,
      activeSeconds: 120,
      pendingToolGraceSeconds: 900,
    });
  });
});

describe('importSettingsOf', () => {
  it('gives the defaults of 02 1.2 for the shipped configuration', async () => {
    expect(importSettingsOf(await configOf())).toEqual(DEFAULT_IMPORT_SETTINGS);
  });

  it('takes the keys that are set', async () => {
    const settings = importSettingsOf(
      await configOf({ import: { sliceMs: 33, lookbackHours: 24, untrackAfterHours: 12 } }),
    );
    expect(settings).toMatchObject({ sliceMs: 33, lookbackHours: 24, untrackAfterHours: 12 });
  });
});

describe('sessionRulesOf', () => {
  it('keeps match and label and reads name and scope loosely', async () => {
    const config = await configOf();
    const withRules: ResolvedConfig = {
      ...config,
      monitor: {
        ...config.monitor,
        session_rules: [
          { match: 'alpha', label: 'A' },
          { match: 'beta', name: 'B', scope: 'any' },
          { match: 'gamma', name: 7, scope: null },
        ],
      },
    };
    expect(sessionRulesOf(withRules)).toEqual([
      { match: 'alpha', label: 'A' },
      { match: 'beta', name: 'B', scope: 'any' },
      { match: 'gamma' },
    ]);
  });

  it('is empty without rules', async () => {
    expect(sessionRulesOf(await configOf())).toEqual([]);
  });
});
