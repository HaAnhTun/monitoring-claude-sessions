// Removes build outputs so a removed source file can never survive as stale JS in dist/.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGES, RUNTIME_ROOT } from './lib.mjs';

const targets = [
  ...PACKAGES.map((p) => join(RUNTIME_ROOT, 'packages', p, 'dist')),
  join(RUNTIME_ROOT, 'coverage'),
  join(RUNTIME_ROOT, '.mcs-build.json'),
];
for (const target of targets) {
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`clean: removed ${targets.length} build output paths`);
