// Handler entry, emitted as `dist/hook.js` (02 1.1). The installed stub `scripts/mcs-hook.mjs` imports this module and calls
// `runHook` itself; `node dist/hook.js --mcs-hook <Event>` runs the handler directly (the main-module guard below, E10).
// Importing the module starts nothing. Imports only node:*, @mcs/shared/protocol and ./ (05 2.6 hook lint block).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runHook } from './hook/main.ts';

export { HANDLER_VERSION } from '@mcs/shared/protocol';
export { runHook };

function isMainModule(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) void runHook(process.argv.slice(2));
