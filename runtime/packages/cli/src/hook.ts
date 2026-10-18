// Handler entry, emitted as `dist/hook.js` (02 1.1) and as the bundle's `mcs-hook.mjs` (ADR 0062 item 6). The installed stub
// `scripts/mcs-hook.mjs` imports this module and calls `runHook` itself; `node dist/hook.js --mcs-hook <Event>` runs the handler
// directly (the main-module guard below, E10). Run directly, it carries the whole install contract of the stub, so the hooks
// installer may copy the bundle file alone: `--version` without `--mcs-hook` prints the handler version, hook mode is silent.
// Importing the module starts nothing. Imports only node:*, @mcs/shared/protocol and ./ (05 2.6 hook lint block).
import { realpathSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { HANDLER_VERSION } from '@mcs/shared/protocol';

import { runHook } from './hook/main.ts';

export { HANDLER_VERSION, runHook };

function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const argv = process.argv.slice(2);
  // fd 1 directly: the hook imports neither the CLI terminal module nor the logger (05 2.6 hook lint block)
  if (!argv.includes('--mcs-hook') && argv.includes('--version')) writeSync(1, `${HANDLER_VERSION}\n`);
  else void runHook(argv);
}
