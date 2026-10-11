// Entry of the server process (01 4.1; registry 2.9):
//   node <skill>/runtime/packages/server/dist/main.js serve --mcs-instance=<id> --instance-dir=<abs> [--port=<n>] [--log-level=<l>]
// The path of this file is the runtime marker that `stop` looks for in a command line (01 4.1, ADR 0006), so it never moves.
// Everything else is `serveMain` in `boot.ts`; this file only names the runtime folder (three levels above `dist/`) and exits.
import { fileURLToPath } from 'node:url';

import { serveMain } from './boot.ts';

process.exit(
  await serveMain({
    argv: process.argv.slice(2),
    env: process.env,
    runtimeDir: fileURLToPath(new URL('../../..', import.meta.url)),
  }),
);
