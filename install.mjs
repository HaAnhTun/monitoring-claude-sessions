// Install path (b) of ADR 0061 item 7: copies the self-contained skill folder `skills/monitoring-claude-sessions/` of this
// checkout to `<CLAUDE_CONFIG_DIR or ~/.claude>/skills/monitoring-claude-sessions/` (or `<project>/.claude/skills/...`, or
// `<dest>/monitoring-claude-sessions/`), for people who clone the repository instead of installing the plugin. Plain ESM,
// `node:*` imports only: it needs nothing but Node.
//
//   node install.mjs [--project <dir>] [--dest <skills dir>] [--force] [--dry-run] [--uninstall]
//
// Exit codes: 0 done, 1 refused or failed, 2 usage. Safety rules: a destination is compared with the source by real paths
// (links resolved) and refused when it equals, contains or lies inside the source folder or the checkout, when it is a link or a
// file, or when its folder is a filesystem root; `--force` and `--uninstall` only touch a folder that holds the install marker
// `.mcs-installed.json`, a `SKILL.md` named monitoring-claude-sessions, and no `.git`, `runtime/package.json` or
// `.claude-plugin`. A new copy is built in a temp sibling and renamed into place; with `--force` the old copy is renamed to
// `<dest>.bak-<UTC stamp>` first and removed only after the launcher self-check (`scripts/caw.mjs --version`) of the new copy
// passed (on a failure the new copy is removed and the old one renamed back). The marker is written as the last step.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKILL_NAME = 'monitoring-claude-sessions';
export const MARKER = '.mcs-installed.json';
/** The canonical launcher of the skill (CAW-04); the self-check runs it. `scripts/mcs.mjs` is only its alias. */
export const LAUNCHER_FILE = 'caw.mjs';
const CHECKOUT_SIGNS = ['.git', join('runtime', 'package.json'), '.claude-plugin'];

const USAGE = [
  'usage: node install.mjs [--project <dir>] [--dest <skills dir>] [--force] [--dry-run] [--uninstall]',
  '  default destination: <CLAUDE_CONFIG_DIR or ~/.claude>/skills/monitoring-claude-sessions',
  '  --project <dir>   install into <dir>/.claude/skills/monitoring-claude-sessions',
  '  --dest <dir>      install into <dir>/monitoring-claude-sessions',
  '  --force           replace an existing install (made by this script)',
  '  --dry-run         print the paths and every decision, write nothing',
  '  --uninstall       remove an install made by this script',
].join('\n');

class Refusal extends Error {}

/** Parses the arguments: `{ options }` or `{ usage: message }`. */
export function parseArgs(argv) {
  const options = { project: undefined, dest: undefined, force: false, dryRun: false, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project' || arg === '--dest') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) return { usage: `${arg} needs a folder` };
      options[arg.slice(2)] = value;
      i += 1;
    } else return { usage: `unknown argument: ${arg}` };
  }
  if (options.project !== undefined && options.dest !== undefined)
    return { usage: '--project and --dest exclude each other' };
  if (options.force && options.uninstall) return { usage: '--force and --uninstall exclude each other' };
  return { options };
}

/** The skills folder the options name (not resolved for links). */
export function skillsDirOf(options, env) {
  if (options.dest !== undefined) return resolve(options.dest);
  if (options.project !== undefined) return resolve(options.project, '.claude', 'skills');
  const config = env.CLAUDE_CONFIG_DIR;
  return config !== undefined && config !== '' ? resolve(config, 'skills') : join(homedir(), '.claude', 'skills');
}

/** The real path of `path`; for a missing path, the real path of its nearest existing ancestor plus the rest. */
export function realOf(path) {
  const rest = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
}

function norm(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** True when `child` equals `parent` or lies inside it (both real, absolute paths). */
export function isInside(child, parent) {
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isRoot(path) {
  return parse(path).root === path || norm(resolve(path)) === norm(parse(resolve(path)).root);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** True when the folder holds a `SKILL.md` whose front matter says `name: monitoring-claude-sessions`. */
function hasSkillManifest(dir) {
  try {
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    return front !== null && /^name:\s*monitoring-claude-sessions\s*$/m.test(front[1]);
  } catch {
    return false;
  }
}

/** The version of the source skill folder from its bundle stamp, or null. */
function sourceVersion(source) {
  try {
    const stamp = JSON.parse(readFileSync(join(source, 'bundle', '.mcs-build.json'), 'utf8'));
    return typeof stamp.runtimeVersion === 'string' ? stamp.runtimeVersion : null;
  } catch {
    return null;
  }
}

/** `20261019T101112Z` from a date. */
export function utcStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * Copies `from` into the new folder `to`, file by file in sorted order, and returns the relative file paths (forward
 * slashes). A link or a special file in the source stops the copy: the skill folder must be self-contained.
 */
function copyTree(from, to, prefix, files) {
  mkdirSync(to);
  const entries = readdirSync(from, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const stat = lstatSync(src);
    if (stat.isSymbolicLink()) throw new Error(`the source holds a link: ${rel}`);
    if (stat.isDirectory()) copyTree(src, dst, rel, files);
    else if (stat.isFile()) {
      copyFileSync(src, dst);
      files.push(rel);
    } else throw new Error(`the source holds a special file: ${rel}`);
  }
  return files;
}

/** Runs the launcher of an installed copy with `--version`: `{ ok, version, detail }`. */
function selfCheck(dir) {
  const launcher = join(dir, 'scripts', LAUNCHER_FILE);
  const run = spawnSync(process.execPath, [launcher, '--version'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const out = typeof run.stdout === 'string' ? run.stdout.trim() : '';
  const m = /^mcs (\S+)$/m.exec(out);
  if (run.status === 0 && m !== null) return { ok: true, version: m[1], detail: out };
  const err = typeof run.stderr === 'string' ? run.stderr.trim() : '';
  return { ok: false, version: null, detail: `exit ${String(run.status)}${err === '' ? '' : `: ${err}`}` };
}

function removeTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** The checks shared by every mode; returns the facts the plan needs or throws a Refusal. */
function inspect(options, env, scriptDir, say) {
  const checkout = realOf(scriptDir);
  const sourcePath = join(checkout, 'skills', SKILL_NAME);
  if (!existsSync(join(sourcePath, 'scripts', LAUNCHER_FILE)) || !hasSkillManifest(sourcePath)) {
    throw new Refusal(`no skill folder next to install.mjs (expected ${sourcePath})`);
  }
  const source = realOf(sourcePath);
  const skillsDir = skillsDirOf(options, env);
  const target = join(skillsDir, SKILL_NAME);
  const realSkillsDir = realOf(skillsDir);
  const realTarget = realOf(target);
  say(`source:      ${source} (version ${String(sourceVersion(source))})`);
  say(`destination: ${target}`);
  say(`real path:   ${realTarget}`);
  if (isRoot(realSkillsDir) || isRoot(realTarget)) {
    throw new Refusal(`the destination folder ${realSkillsDir} is a filesystem root`);
  }
  if (isInside(realTarget, checkout) || isInside(checkout, realTarget)) {
    throw new Refusal(
      options.project !== undefined && norm(realTarget) === norm(checkout)
        ? `${target} resolves to the source checkout ${checkout}: this project already uses the checkout itself`
        : `the destination ${realTarget} equals, contains or lies inside the source checkout ${checkout}`,
    );
  }
  if (isInside(realTarget, source) || isInside(source, realTarget)) {
    throw new Refusal(`the destination ${realTarget} equals, contains or lies inside the source folder ${source}`);
  }
  const stat = lstatOrNull(target);
  if (stat !== null && stat.isSymbolicLink()) throw new Refusal(`the destination ${target} is a link`);
  if (stat !== null && !stat.isDirectory()) throw new Refusal(`the destination ${target} is not a folder`);
  say(`decision:    paths are separate from the source checkout`);
  return { checkout, source, skillsDir, target, exists: stat !== null };
}

/** Refuses a folder that this script may not replace or remove. */
function checkReplaceable(target, say) {
  for (const sign of CHECKOUT_SIGNS) {
    if (existsSync(join(target, sign))) throw new Refusal(`${target} holds ${sign}: it looks like a checkout`);
  }
  if (!existsSync(join(target, MARKER)))
    throw new Refusal(`${target} has no ${MARKER}: it was not installed by this script`);
  if (!hasSkillManifest(target)) throw new Refusal(`${target} holds no SKILL.md named ${SKILL_NAME}`);
  say(`decision:    ${target} is an install made by this script`);
}

function uninstall(facts, options, say) {
  if (!facts.exists) throw new Refusal(`nothing to uninstall: ${facts.target} does not exist`);
  checkReplaceable(facts.target, say);
  if (options.dryRun) {
    say(`dry run:     would remove ${facts.target}`);
    return;
  }
  removeTree(facts.target);
  say(`removed:     ${facts.target}`);
}

function install(facts, options, say) {
  const { source, skillsDir, target } = facts;
  if (facts.exists) {
    if (!options.force) throw new Refusal(`${target} already exists; use --force to replace it`);
    checkReplaceable(target, say);
  }
  const stamp = utcStamp(new Date());
  const staging = join(skillsDir, `.${SKILL_NAME}.tmp-${stamp}-${String(process.pid)}`);
  let backup = `${target}.bak-${stamp}`;
  if (existsSync(backup)) backup = `${backup}-${String(process.pid)}`;
  say(`decision:    copy ${source} to the temp sibling ${staging}`);
  if (facts.exists) say(`decision:    rename the old copy to ${backup}, remove it after the self-check`);
  say(`decision:    rename the temp sibling to ${target}, run its launcher --version, write ${MARKER}`);
  if (options.dryRun) {
    say('dry run:     nothing written');
    return;
  }
  mkdirSync(skillsDir, { recursive: true });
  let files;
  try {
    files = copyTree(source, staging, '', []);
  } catch (error) {
    removeTree(staging);
    throw new Error(`copy failed, nothing changed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (facts.exists) renameSync(target, backup);
  try {
    renameSync(staging, target);
  } catch (error) {
    removeTree(staging);
    if (facts.exists) renameSync(backup, target);
    throw error;
  }
  const check = selfCheck(target);
  if (!check.ok) {
    removeTree(target);
    if (facts.exists) renameSync(backup, target);
    throw new Error(
      `self-check of the new copy failed (${check.detail}); ${facts.exists ? 'the old copy is back' : 'nothing installed'}`,
    );
  }
  const marker = {
    skill: SKILL_NAME,
    version: check.version,
    sourceVersion: sourceVersion(source),
    installedAt: new Date().toISOString(),
    files,
  };
  writeFileSync(join(target, MARKER), JSON.stringify(marker, null, 2) + '\n');
  if (facts.exists) removeTree(backup);
  say(`installed:   ${target} (mcs ${String(check.version)}, ${String(files.length)} files)`);
}

/** Runs the installer and returns the exit code. `io` carries `out` and `err` line writers. */
export function main(argv, env, scriptDir, io) {
  const parsed = parseArgs(argv);
  if (parsed.usage !== undefined) {
    io.err(`ERROR: ${parsed.usage}`);
    io.err(USAGE);
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    io.out(USAGE);
    return 0;
  }
  try {
    const facts = inspect(options, env, scriptDir, io.out);
    if (options.uninstall) uninstall(facts, options, io.out);
    else install(facts, options, io.out);
    return 0;
  } catch (error) {
    io.err(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isEntry() {
  try {
    const entry = process.argv[1];
    return (
      entry !== undefined &&
      pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = main(process.argv.slice(2), process.env, dirname(fileURLToPath(import.meta.url)), {
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  });
}
