// FIXTURE: invented data for tests
import type { ConfigInspection } from '@mcs/shared';

export function makeConfigInspection(overrides: Partial<ConfigInspection> = {}): ConfigInspection {
  return {
    entries: [
      { key: 'port', value: 18900, source: 'builtin' },
      { key: 'poll.overview_ms', value: 5000, source: 'config' },
    ],
    files: [{ name: 'defaults.json', path: 'FIXTURE/defaults.json', schemaVersion: 1, present: true, ok: true }],
    effectivePort: 18900,
    engine: 'node',
    ...overrides,
  };
}
