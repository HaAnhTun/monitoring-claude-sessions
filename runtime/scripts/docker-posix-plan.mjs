// Pure planning half of the Docker POSIX harness (ADR 0065 item 4): targets, derived image Dockerfiles and tags, gate lists,
// the in-container shell script and the `docker` argument lists. No I/O here, so the tests can check every command line.
import { createHash } from 'node:crypto';

export const SUMMARY_SCHEMA = 'mcs.docker-posix/1';
export const HARNESS_LABEL = 'mcs-v4-harness=1';
export const RUN_LABEL_KEY = 'mcs-v4-run';
export const DEFAULT_TARGETS = ['node22', 'node24', 'node26', 'alpine24'];
export const PLATFORMS = ['amd64', 'arm64'];
/** The Node floor of the launcher (owner decision 3); the `floor` target expects a message that names it. */
export const NODE_FLOOR = '22.22.0';

/** Official base images; `floor` is an image below the floor that only checks the launcher's refusal. */
export const TARGETS = {
  node22: { base: 'node:22-bookworm-slim', family: 'debian' },
  node24: { base: 'node:24-bookworm-slim', family: 'debian' },
  node26: { base: 'node:26-bookworm-slim', family: 'debian' },
  alpine24: { base: 'node:24-alpine', family: 'alpine' },
  floor: { base: 'node:20-alpine', family: 'alpine', platforms: ['amd64'], floor: true },
};

/** Where the source tar is unpacked inside the container (owned by the unprivileged `node` user). */
export const WORK_DIR = '/home/node/work';

/** The quick gate list (arm64 default, `--quick`): one constant, read by nothing else at run time. */
export const QUICK_GATES = [
  ['build', 'npm run build'],
  ['test', 'npm test'],
  ['smoke', 'node scripts/smoke.mjs --bundle'],
];

/** Gates of a non-floor target, in order. `npm ci` always runs first: the source tar carries no node_modules. */
export function gatesFor({ quick, bundle }) {
  const setup = [['npm ci', 'npm ci --no-audit --no-fund']];
  if (quick) {
    const list = [...setup, ...QUICK_GATES];
    if (bundle) list.push(['bundle:check', 'node scripts/bundle.mjs --check']);
    return list;
  }
  return [...setup, ['ci', `npm run ci -- --offline${bundle ? ' --bundle' : ''}`]];
}

/** The Dockerfile of a derived image: the official image plus `git` and `ps` (procps), which slim and Alpine images lack. */
export function dockerfileFor(target, platform) {
  const spec = TARGETS[target];
  const install =
    spec.family === 'alpine'
      ? 'RUN apk add --no-cache git procps'
      : 'RUN apt-get update && apt-get install -y --no-install-recommends git procps && rm -rf /var/lib/apt/lists/*';
  return [
    `FROM --platform=linux/${platform} ${spec.base}`,
    install,
    `LABEL ${HARNESS_LABEL.replace('=', '="')}"`,
    `RUN mkdir -p ${WORK_DIR} && chown node:node ${WORK_DIR}`,
    'USER node',
    `WORKDIR ${WORK_DIR}`,
    '',
  ].join('\n');
}

/** `mcs-posix/<target>:<hash of the Dockerfile text>`; the platform is part of the text (the FROM line), so of the hash. */
export function imageTag(target, platform) {
  const hash = createHash('sha256').update(dockerfileFor(target, platform)).digest('hex').slice(0, 12);
  return `mcs-posix/${target}:${hash}`;
}

/** Key of one target on one platform: the target name on amd64, `<target>-arm64` on arm64 (container name and log file). */
export function targetKey(target, platform) {
  return platform === 'amd64' ? target : `${target}-${platform}`;
}

/** Single-quotes a string for POSIX `sh`. */
export function shQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`;
}

/**
 * The `sh -c` script run in the container: unpack the tar from stdin, then run each gate with a timer and print the
 * `| gate | result | ms |` table. A failing gate stops the later ones (they need its output) and the exit code is 1.
 */
export function containerScript({ target, quick, bundle }) {
  const lines = [
    'set -u',
    `cd ${WORK_DIR} || exit 90`,
    'tar -x -f - || { echo "harness: tar extraction failed"; exit 91; }',
  ];
  if (TARGETS[target].floor) {
    lines.push(
      'launcher=skills/monitoring-claude-sessions/scripts/caw.mjs',
      '[ -f "$launcher" ] || launcher=scripts/caw.mjs',
      'out=$(node "$launcher" --version 2>&1); code=$?',
      'printf "%s\\n" "$out"',
      'echo "| gate | result | ms |"',
      'echo "|---|---|---|"',
      `if [ "$code" -eq 1 ] && printf "%s" "$out" | grep -q ${shQuote(NODE_FLOOR)}; then echo "| floor | PASS | 0 |"; exit 0; fi`,
      'echo "| floor | FAIL (exit $code) | 0 |"',
      'exit 1',
    );
    return lines.join('\n');
  }
  lines.push('cd runtime || exit 92', 'rows=""', 'status=0');
  for (const [name, command] of gatesFor({ quick, bundle })) {
    lines.push(
      `if [ "$status" -eq 0 ]; then`,
      `  echo ${shQuote(`=== ${name}`)}`,
      `  t0=$(node -p 'Date.now()')`,
      `  sh -c ${shQuote(command)}; code=$?`,
      `  t1=$(node -p 'Date.now()')`,
      `  if [ "$code" -eq 0 ]; then r=PASS; else r="FAIL (exit $code)"; status=1; fi`,
      `  rows="$rows| ${name} | $r | $((t1 - t0)) |\n"`,
      `fi`,
    );
  }
  lines.push('echo "| gate | result | ms |"', 'echo "|---|---|---|"', 'printf "%b" "$rows"', 'exit "$status"');
  return lines.join('\n');
}

/** Argument list of the derived image build: Dockerfile on stdin, no context folder. */
export function buildArgs(target, platform) {
  return ['build', '--label', HARNESS_LABEL, '--platform', `linux/${platform}`, '-t', imageTag(target, platform), '-'];
}

/** Budget multiplier of the performance tests on arm64: the image runs under QEMU emulation on an amd64 host. */
export const EMULATED_PERF_FACTOR = 8;

/** Argument list of one target run. No volume, mount, port, host network, pid namespace or privilege flag, ever. */
export function runArgs({ runId, target, platform, quick, bundle, keep }) {
  return [
    'run',
    ...(keep ? [] : ['--rm']),
    '-i',
    '--init',
    '--platform',
    `linux/${platform}`,
    '--label',
    HARNESS_LABEL,
    '--label',
    `${RUN_LABEL_KEY}=${runId}`,
    '--name',
    `mcs-posix-${runId}-${targetKey(target, platform)}`,
    '--memory',
    '3g',
    '--user',
    'node',
    '-e',
    'CI=1',
    '-e',
    'TZ=UTC',
    '-e',
    'MCS_HOOK_DISABLE=1',
    ...(platform === 'arm64' ? ['-e', `MCS_PERF_FACTOR=${EMULATED_PERF_FACTOR}`] : []),
    imageTag(target, platform),
    'sh',
    '-c',
    containerScript({ target, quick, bundle }),
  ];
}

/** Argument lists that list this run's containers (cleanup) or every harness container (`--prune`); label scoped only. */
export function listContainersArgs(label) {
  return ['ps', '-a', '-q', '--filter', `label=${label}`];
}

export function listImagesArgs() {
  return ['images', '-q', '--filter', `label=${HARNESS_LABEL}`];
}

/** Expands `--targets` x `--platform` into the ordered run list; `floor` runs on amd64 only. */
export function expandRuns({ targets, platform, quick }) {
  const platforms = platform === 'all' ? PLATFORMS : [platform];
  const runs = [];
  for (const p of platforms) {
    for (const target of targets) {
      const allowed = TARGETS[target].platforms ?? PLATFORMS;
      if (!allowed.includes(p)) continue;
      runs.push({ target, platform: p, quick: quick || p === 'arm64' });
    }
  }
  return runs;
}

/** Parses every `| gate | result | ms |` table of a log; the last one is the target's own gate table. */
export function parseGateTables(text) {
  const tables = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\|\s*gate\s*\|\s*result\s*\|\s*ms\s*\|$/.test(line)) {
      current = [];
      tables.push(current);
      continue;
    }
    if (current === null) continue;
    if (/^\|[-\s|]+\|$/.test(line)) continue;
    const match = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|$/.exec(line);
    if (match) current.push({ name: match[1], result: match[2], ms: Number(match[3]) });
    else current = null;
  }
  return tables;
}
