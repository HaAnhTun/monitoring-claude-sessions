// The runtime version (01 section 5.2). `version.test.ts` fails when it differs from the workspace manifests;
// bump it with `scripts/set-version.mjs` and edit this line in the same commit (05 section 2.2).

/** Equals `runtime/package.json` `version`. */
export const RUNTIME_VERSION = '4.0.0';
