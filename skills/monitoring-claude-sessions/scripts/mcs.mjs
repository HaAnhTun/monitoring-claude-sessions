// The alias `mcs` of the launcher (design 07 section 5.2): `node scripts/mcs.mjs <command>` does what `node scripts/caw.mjs <command>`
// does. All of the logic lives in `caw.mjs`; this file only names the program `mcs` and hands over the path of `caw.mjs`, so that
// the CLI prints the canonical launcher in the commands it shows. Plain ESM, ES2020, no environment variable read here.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntry, run } from './caw.mjs';

if (isEntry(import.meta.url)) {
  run(process.argv.slice(2), {
    program: 'mcs',
    launcherPath: join(dirname(fileURLToPath(import.meta.url)), 'caw.mjs'),
  });
}
