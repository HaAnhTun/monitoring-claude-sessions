// Sets one version on the root and on every workspace manifest, and on every internal @mcs/* dependency spec.
// Usage: node scripts/set-version.mjs <semver>   then: npm install --package-lock-only --offline && npm run ci
// Zero dependencies. Bump procedure of 05-tooling-testing-security.md section 2.2.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PACKAGES, RUNTIME_ROOT } from './lib.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const version = process.argv[2];
if (version === undefined || !SEMVER.test(version)) {
  console.error('usage: node scripts/set-version.mjs <semver>  (for example 3.0.1 or 3.1.0-rc.1)');
  process.exit(2);
}

const manifests = [
  join(RUNTIME_ROOT, 'package.json'),
  ...PACKAGES.map((name) => join(RUNTIME_ROOT, 'packages', name, 'package.json')),
];
// Validate and compute every manifest first, then write, so a failure cannot leave a mixed state.
const updates = manifests.map((file) => {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  for (const field of DEP_FIELDS) {
    const deps = json[field];
    if (deps === undefined) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@mcs/')) deps[name] = version;
    }
  }
  return {
    file,
    text: `${JSON.stringify(json, null, 2)}
`,
  };
});
for (const { file, text } of updates) {
  writeFileSync(file, text);
  console.log(`set-version: ${file.slice(RUNTIME_ROOT.length + 1) || 'package.json'} -> ${version}`);
}
console.log('set-version: now run "npm install --package-lock-only --offline" and "npm run ci"');
