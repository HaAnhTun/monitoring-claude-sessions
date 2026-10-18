// Entry of the server process (01 4.1; registry 2.9):
//   node <runtimeDir>/packages/server/dist/main.js serve --mcs-instance=<id> --instance-dir=<abs> [--port=<n>] [--log-level=<l>]
// or, in the bundle layout, `node <skillDir>/bundle/mcs-server.mjs serve ...` (ADR 0062 item 2). The path of this file is the
// runtime marker that `stop` looks for in a command line (01 4.1, ADR 0006), so it never moves. Everything else is
// `serveMain` in `boot.ts`; this file only names the runtime folder (through the layout resolver) and exits.
import { layoutOfModule } from '@mcs/engine';

import { serveMain } from './boot.ts';

process.exit(
  await serveMain({
    argv: process.argv.slice(2),
    env: process.env,
    runtimeDir: layoutOfModule(import.meta.url).runtimeDir,
  }),
);
