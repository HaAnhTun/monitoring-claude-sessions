// The launcher `$MCS` = `node "${CLAUDE_SKILL_DIR}/scripts/caw.mjs" <command>` (ADR 0062 item 4; canonical since CAW-04, the old
// `scripts/mcs.mjs` is a short alias that calls `run` below). Committed, plain ESM, `node:*` imports only and no syntax newer than
// ES2020 (no top-level await, no class fields, no `||=`), so that an old Node still parses it and prints the floor message instead
// of a syntax error.
//
// Order: 1. the Node floor (22.22.0); 2. the `--version` / `version --short` fast path, which loads no module; 3. the mode
// (`MCS_LAUNCHER_MODE=bundle|dev`, default bundle when `bundle/mcs-cli.mjs` exists, else dev in a checkout); 4. import the CLI in
// this process and set the exit code from `main(argv, { launcherPath, skillDir, runtimeDir, program })`.
// Never npm, never a build, never a spawn, never a lock, never a workspace read or write: there is nothing to bootstrap.
// `MCS_DEBUG=1` adds the stack to an internal launcher error.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NODE_FLOOR = '22.22.0';

/** The numeric parts of a `major.minor.patch` version (an optional leading `v` and a suffix after the patch are allowed), or null. */
function versionParts(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version));
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `version` is at least the floor. A version that does not parse never meets it. */
export function meetsNodeFloor(version, floor) {
  const have = versionParts(version);
  const need = versionParts(floor === undefined ? NODE_FLOOR : floor);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

/** The exact floor message (ADR 0062 item 4.1, code NODE_TOO_OLD). */
export function floorMessage(version) {
  return `ERROR: Node >= ${NODE_FLOOR} is required (found ${version}); install the Node 24 LTS`;
}

/** The error of a launcher that finds neither the bundle nor a checkout build. */
export function noRuntimeMessage(skillDir) {
  return (
    `ERROR: no runtime found in ${skillDir}: neither bundle/mcs-cli.mjs nor a checkout build ` +
    '(runtime/packages/cli/dist/main.js) exists; run "npm ci && npm run build" in runtime/ of the checkout, ' +
    'or install the skill from a release'
  );
}

/**
 * The mode to run in: `{ mode: 'bundle' | 'dev' }` or `{ error }`. `forced` is the value of `MCS_LAUNCHER_MODE` (undefined or
 * empty: the default); `hasBundle` / `hasDist` say whether `bundle/mcs-cli.mjs` and the checkout's `dist/main.js` exist.
 */
export function chooseMode(forced, hasBundle, hasDist, skillDir) {
  const where = skillDir === undefined ? '.' : skillDir;
  if (forced === 'bundle') {
    return hasBundle
      ? { mode: 'bundle' }
      : {
          error: `ERROR: MCS_LAUNCHER_MODE=bundle but ${where} has no bundle/mcs-cli.mjs`,
        };
  }
  if (forced === 'dev') {
    return hasDist
      ? { mode: 'dev' }
      : {
          error:
            `ERROR: MCS_LAUNCHER_MODE=dev but no checkout build was found next to ${where}; ` +
            'run "npm ci && npm run build" in runtime/ of the checkout',
        };
  }
  if (forced !== undefined && forced !== '') {
    return {
      error: `ERROR: MCS_LAUNCHER_MODE must be bundle or dev (found ${forced})`,
    };
  }
  if (hasBundle) return { mode: 'bundle' };
  if (hasDist) return { mode: 'dev' };
  return { error: noRuntimeMessage(where) };
}

/**
 * The line of the version fast path, `mcs <version>`, from the text of `bundle/.mcs-build.json` (bundle, `runtimeVersion`) or
 * `runtime/package.json` (dev, `version`); null when the text holds no usable version.
 */
export function versionLine(mode, jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const version = mode === 'bundle' ? parsed.runtimeVersion : parsed.version;
  return typeof version === 'string' && version !== '' ? `mcs ${version}` : null;
}

/** True for the argument lists that the fast path answers: `--version` and `version --short`. */
export function isVersionFastPath(argv) {
  if (argv[0] === '--version') return true;
  return argv.length === 2 && argv[0] === 'version' && argv[1] === '--short';
}

/** The folders of the two layouts, derived from the launcher's own path. */
export function launcherPaths(launcherPath) {
  const skillDir = dirname(dirname(launcherPath));
  const repoRuntime = join(skillDir, '..', '..', 'runtime');
  return {
    launcherPath,
    skillDir,
    bundleDir: join(skillDir, 'bundle'),
    bundleEntry: join(skillDir, 'bundle', 'mcs-cli.mjs'),
    devRuntimeDir: repoRuntime,
    devEntry: join(repoRuntime, 'packages', 'cli', 'dist', 'main.js'),
  };
}

/** `versionLine` of a file, or null when the file cannot be read. */
function readVersionLine(mode, file) {
  try {
    return versionLine(mode, readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function printError(line) {
  process.stderr.write(line + '\n');
}

function internalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  printError(`ERROR: internal launcher error: ${message}`);
  if (process.env.MCS_DEBUG === '1' && error instanceof Error && error.stack !== undefined) printError(error.stack);
  process.exitCode = 1;
}

/** The program name the CLI is told about: `mcs` for the alias, `caw` for anything else. */
function programOf(program) {
  return program === 'mcs' ? 'mcs' : 'caw';
}

async function launch(argv, program, launcherPath) {
  const node = process.versions.node;
  if (!meetsNodeFloor(node)) {
    printError(floorMessage(node));
    process.exitCode = 1;
    return;
  }
  const paths = launcherPaths(launcherPath);
  const choice = chooseMode(
    process.env.MCS_LAUNCHER_MODE,
    existsSync(paths.bundleEntry),
    existsSync(paths.devEntry),
    paths.skillDir,
  );
  if (choice.error !== undefined) {
    printError(choice.error);
    process.exitCode = 1;
    return;
  }
  const bundleMode = choice.mode === 'bundle';
  if (isVersionFastPath(argv)) {
    const file = bundleMode ? join(paths.bundleDir, '.mcs-build.json') : join(paths.devRuntimeDir, 'package.json');
    const line = readVersionLine(choice.mode, file);
    if (line !== null) {
      process.stdout.write(line + '\n');
      process.exitCode = 0;
      return;
    }
    // no readable version file: the CLI answers below
  }
  const entry = bundleMode ? paths.bundleEntry : paths.devEntry;
  const runtimeDir = bundleMode ? paths.bundleDir : paths.devRuntimeDir;
  const cli = await import(pathToFileURL(entry).href);
  if (typeof cli.main !== 'function') throw new Error(`${entry} exports no main function`);
  const code = await cli.main(argv, {
    launcherPath: paths.launcherPath,
    skillDir: paths.skillDir,
    runtimeDir,
    program,
  });
  process.exitCode = typeof code === 'number' ? code : 1;
}

/**
 * Runs the launcher for the layout that `launcherPath` names (default: this file), sets `process.exitCode` and never throws.
 * `program` is `caw` or `mcs` (default and any other value: `caw`); the alias `mcs.mjs` and the legacy shims pass `mcs`. The CLI
 * is handed the program name next to the paths, so that the one note for people who still type `mcs` can be shown; the
 * `launcherPath` it prints in commands is always the one given here, which the alias sets to the path of `caw.mjs`.
 */
export async function run(argv, options) {
  const given = options === undefined || options === null ? {} : options;
  const launcherPath =
    typeof given.launcherPath === 'string' && given.launcherPath !== ''
      ? given.launcherPath
      : fileURLToPath(import.meta.url);
  try {
    await launch(argv, programOf(given.program), launcherPath);
  } catch (error) {
    internalError(error);
  }
}

/**
 * True when the module with this `import.meta.url` is the process entry (`node caw.mjs ...`), false when another module or a
 * test imports it. `caw.mjs` and the alias `mcs.mjs` both ask it, so that importing either has no side effect.
 */
export function isEntry(moduleUrl) {
  try {
    const entry = process.argv[1];
    return (
      entry !== undefined &&
      pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href
    );
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) {
  run(process.argv.slice(2), {
    program: 'caw',
    launcherPath: fileURLToPath(import.meta.url),
  });
}
