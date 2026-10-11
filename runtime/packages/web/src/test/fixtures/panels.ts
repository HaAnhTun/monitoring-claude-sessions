// FIXTURE: invented data for tests
import type { PanelDataMap, PanelKey, PanelResponse, PanelSource, PanelSourceState, PanelStatus } from '@mcs/shared';

import { iso } from './ids.ts';

function lines(): PanelDataMap['ledger'] {
  return {
    lines: ['| part | result |', '| --- | --- |', '| FIXTURE A | PASS |'],
    file: 'FIXTURE-ledger.md',
    exists: true,
    sizeBytes: 64,
    modifiedAt: iso(-10),
  };
}

/** A valid `data` body of each panel. */
export function makePanelData<K extends PanelKey>(key: K): PanelDataMap[K] {
  const data: PanelDataMap = {
    git: {
      branch: 'fixture-branch',
      dirty: 0,
      stopFile: false,
      commits: [{ hash: 'abc1234', subject: 'FIXTURE commit', at: iso(-600) }],
      headOid: 'abc1234def5678',
      detached: false,
      repoState: 'ok',
    },
    machine: {
      sampledAt: iso(-2),
      freeGb: 8,
      totalGb: 16,
      usedPct: 50,
      cpuPct: 10,
      procs: [{ name: 'node', count: 2, mb: 120 }],
      docker: [],
      platform: 'linux',
      procsSampledAt: iso(-2),
      procsStatus: 'ok',
      dockerEnabled: false,
      dockerSampledAt: null,
      dockerStatus: 'disabled',
    },
    attempts: { rows: [], sourceState: 'ok' },
    ledger: lines(),
    chainLog: lines(),
    logs: { files: [], matchedFiles: 0 },
  };
  return data[key];
}

const DEFAULT_SOURCE: Record<PanelKey, PanelSource> = {
  git: 'git.status',
  machine: 'memory',
  attempts: 'attempts',
  ledger: 'ledger',
  chainLog: 'chainLog',
  logs: 'logs',
};

export interface PanelOverrides<K extends PanelKey> {
  status?: PanelStatus;
  generatedAt?: string;
  sources?: PanelSourceState[];
  /** `null` is the `error` answer: no source produced data. */
  data?: PanelDataMap[K] | null;
}

/** `PanelResponse<K>` with the data of the panel; `ok` with one `ok` source unless overridden. */
export function makePanelResponse<K extends PanelKey>(key: K, overrides: PanelOverrides<K> = {}): PanelResponse<K> {
  const generatedAt = overrides.generatedAt ?? iso(0);
  const response = {
    key,
    status: overrides.status ?? 'ok',
    generatedAt,
    sources: overrides.sources ?? [
      { source: DEFAULT_SOURCE[key], status: 'ok', sampledAt: generatedAt, message: null },
    ],
    data: overrides.data === undefined ? makePanelData(key) : overrides.data,
  };
  // The discriminated union of the contract cannot be narrowed from a generic key; the factory is only used in tests.
  return response as PanelResponse<K>;
}
