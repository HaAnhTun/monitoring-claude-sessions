// The native files of a BUILT bundle, loaded by path in a folder with a space and a non-ASCII letter in its name (CAW-56; design 01
// sections 2.5 and 8, design 08 sections 3.4 and 4.3, id TC-PTY-01; amendment A5). The bundle is built by the real
// `scripts/bundle.mjs --out <folder> --no-web --native-targets <host>`: the staging comes from the installed package (no network:
// `MCS_NATIVE_TARBALLS` names an empty folder, so a fallback could only fail) and no other target is staged. A probe is then run FROM
// the bundle folder (`support/bundle-load-probe.mjs`, next to `mcs-server.mjs`): the production loader finds the bundle layout from
// the URL of the probe and requires `native/<host>/lib/index.js` by path, and the fake claude runs through what it loaded. The
// console-host files (`conpty.dll`, `OpenConsole.exe`) are located relative to the `.node` file, so the dll flavour is run too and
// the test looks at the file the console host really runs from.
// arm64: no binary is executed (no ARM64 machine); the pins, the lockfile and, where an offline copy exists, the hashes are
// checked. Windows only; a missing addon FAILS the run (`describePtyTests`).
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describePtyTests, waitFor } from '@mcs/testkit';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { hostPlatform } from '../../src/platform/host.ts';
import { SHIPPED_TARGETS, targetOf } from '../../src/terminal/index.ts';
import { HOST_TARGET, RUNTIME_ROOT, readPins, sha256Of as sha256 } from './native-files.ts';
import { addedHosts, consoleHostsOf, listProcesses, type ProcessRow } from './process-tree.ts';
import {
  E_ACUTE,
  ENGINE_TERMINAL_URL,
  PER_TEST_TIMEOUT_MS,
  SOURCE_NODE_FLAGS,
  exitWaitMs,
  outputWaitMs,
  supportScript,
  useRealHarnesses,
  type RealHarness,
} from './real-harness.ts';

const BUNDLE_SCRIPT = path.join(RUNTIME_ROOT, 'scripts', 'bundle.mjs');
/** A full build with rolldown takes about a second here; the rest is the load of a busy machine. */
const BUILD_TIMEOUT_MS = 300_000;
const BUNDLE_TEST_TIMEOUT_MS = PER_TEST_TIMEOUT_MS * 2;

const LockSchema = z.object({
  packages: z.record(z.string(), z.object({ version: z.string().optional(), integrity: z.string().optional() })),
});

/** The line that tells the probe to go on (`String.fromCharCode(10)` is a line feed: the probe reads lines). */
const GO_LINE = `go${String.fromCharCode(10)}`;

// ---- building ------------------------------------------------------------------------------------------------------------------

/** `<root>/bundle caf<e acute> x/bundle folder`: a space and a character outside ASCII in two levels. */
function bundleFolder(h: RealHarness): string {
  return path.join(h.root, `bundle caf${E_ACUTE} x`, 'bundle folder');
}

interface Built {
  readonly dir: string;
  readonly stdout: string;
}

/** Runs the real bundle script into a fresh folder of the harness's temp root. Rejects with the exit code and the output when it fails. */
function buildBundle(h: RealHarness, nativeArgs: readonly string[]): Promise<Built> {
  const dir = bundleFolder(h);
  const offline = path.join(h.root, 'no tarballs');
  mkdirSync(offline, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BUNDLE_SCRIPT, '--out', dir, '--no-web', ...nativeArgs],
      {
        cwd: RUNTIME_ROOT,
        env: { ...process.env, MCS_NATIVE_TARBALLS: offline },
        windowsHide: true,
        timeout: BUILD_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) resolve({ dir, stdout });
        else
          reject(new Error(`the bundle build failed (${String(error.code ?? error.signal)}): ${stderr.slice(-400)}`));
      },
    );
  });
}

// ---- the probe -----------------------------------------------------------------------------------------------------------------

interface ProbeEvent {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

interface ProbeRun {
  readonly events: readonly ProbeEvent[];
  readonly code: number | null;
  readonly stderr: string;
}

function eventOf(line: string): ProbeEvent {
  const value: unknown = JSON.parse(line);
  const name: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'event') : undefined;
  if (typeof name !== 'string') throw new Error('the probe wrote a line that is not an event');
  const fields: Record<string, unknown> = {};
  if (typeof value === 'object' && value !== null) {
    for (const [key, field] of Object.entries(value)) if (key !== 'event') fields[key] = field;
  }
  return { event: name, fields };
}

/**
 * Copies the probe next to the entry of the bundle and runs it from there. When the probe reports `loaded`, and again when it reports
 * `ready`, the hook of that stage runs while the probe waits (it gets the pid of the probe, whose pseudo console hosts are its
 * children); then the probe is told to go on.
 */
async function runProbe(
  h: RealHarness,
  bundle: string,
  mode: 'inbox' | 'dll' | 'missing',
  hooks: { atLoaded?: (probePid: number) => Promise<void>; atReady?: (probePid: number) => Promise<void> } = {},
): Promise<ProbeRun> {
  const probe = path.join(bundle, 'probe.mjs');
  copyFileSync(supportScript('bundle-load-probe.mjs'), probe);
  const child = spawn(
    process.execPath,
    [...SOURCE_NODE_FLAGS, probe, ENGINE_TERMINAL_URL, h.install.script, h.projectDir(), mode, String(outputWaitMs())],
    { cwd: h.root, env: h.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.on('error', () => undefined);
  const { pid } = child;
  if (pid === undefined) throw new Error('the probe did not start');
  h.track(pid);

  const events: ProbeEvent[] = [];
  let buffered = '';
  let stderr = '';
  const closed: { code: number | null | undefined } = { code: undefined };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      const line = buffered.slice(0, end).trim();
      buffered = buffered.slice(end + 1);
      if (line !== '') events.push(eventOf(line));
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.on('close', (code) => {
    closed.code = code;
  });

  const names = (): string => events.map((e) => e.event).join(',');
  try {
    if (mode !== 'missing') {
      for (const [stage, hook] of [
        ['loaded', hooks.atLoaded],
        ['ready', hooks.atReady],
      ] as const) {
        await waitFor(
          () => {
            if (closed.code !== undefined) {
              throw new Error(`the probe ended early (code ${String(closed.code)}): ${names()}`);
            }
            return events.some((e) => e.event === stage || e.event === 'error');
          },
          { timeoutMs: outputWaitMs() * 2, intervalMs: 50, what: `the probe to report ${stage}` },
        );
        if (!events.some((e) => e.event === stage)) break;
        await hook?.(pid);
        child.stdin.write(GO_LINE);
      }
    }
    await waitFor(() => closed.code !== undefined, {
      timeoutMs: exitWaitMs() * 2,
      intervalMs: 100,
      what: `the probe to finish (${names()})`,
    });
  } finally {
    child.stdin.end();
  }
  return { events, code: closed.code ?? null, stderr };
}

function fieldsOf(run: ProbeRun, name: string): Readonly<Record<string, unknown>> {
  const found = run.events.find((e) => e.event === name);
  if (found === undefined)
    throw new Error(`the probe wrote no ${name} event: ${run.events.map((e) => e.event).join(',')}`);
  return found.fields;
}

function pidField(fields: Readonly<Record<string, unknown>>, name: string): number {
  const value = fields[name];
  if (typeof value !== 'number') throw new Error(`the probe event has no number ${name}`);
  return value;
}

/** What every probe run must show, whichever flavour: loaded by path from the bundle, a session that resizes and exits, a kill that ends the tree. */
async function expectProbeSucceeded(h: RealHarness, run: ProbeRun): Promise<void> {
  expect(run.stderr).toBe('');
  expect(run.code).toBe(0);
  expect(run.events.map((e) => e.event)).toEqual(['loaded', 'ready', 'resized', 'exited', 'killed', 'done']);
  expect(fieldsOf(run, 'loaded')).toEqual({
    via: 'bundle',
    dirIsBundle: true,
    entryFromBundle: true,
    fromNodeModules: false,
  });
  expect(fieldsOf(run, 'resized')).toEqual({ size: '100x40' });
  expect(fieldsOf(run, 'exited')).toEqual({ code: 0, bye: true });
  const killed = fieldsOf(run, 'killed');
  const tree = [pidField(killed, 'rootPid'), pidField(killed, 'fakePid'), pidField(killed, 'childPid')];
  for (const pid of tree) h.track(pid, pid === tree[2] ? '600000' : h.marker);
  // The kill ended the root, the fake claude and the grandchild, from the bundle's lib folder with the console list agent.
  await h.waitGone(
    [...tree, pidField(fieldsOf(run, 'ready'), 'fakePid')],
    'every process of the probe sessions to end',
  );
}

describePtyTests('the native files of a built bundle', () => {
  const start = useRealHarnesses();

  it(
    'TC-PTY-01 the bundle script builds the host target only, offline, into a folder with a space and a non-ASCII letter, and the files equal the pins',
    async () => {
      const h = start({ route: 'direct' });
      const { dir, stdout } = await buildBundle(h, ['--native-targets', HOST_TARGET]);
      expect(dir).toContain(' ');
      expect(/[^ -~]/.test(dir)).toBe(true);
      expect(stdout).toMatch(/^bundle: wrote \d+ files to /);

      // Only the host target: no other target is staged (so no arm64 package is needed, and none is fetched).
      expect(readdirSync(path.join(dir, 'native'))).toEqual([HOST_TARGET]);
      const pins = readPins();
      const pinned = pins.targets[HOST_TARGET];
      if (pinned === undefined) throw new Error(`the pins have no target ${HOST_TARGET}`);
      for (const [rel, pin] of Object.entries(pinned.binary)) {
        const bytes = readFileSync(path.join(dir, 'native', HOST_TARGET, ...rel.split('/')));
        expect(bytes.length, rel).toBe(pin.bytes);
        expect(sha256(bytes), rel).toBe(pin.sha256);
      }
      expect(existsSync(path.join(dir, 'native', HOST_TARGET, 'lib', 'index.js'))).toBe(true);
      // Every debug symbol file stays out, and the notices name the platform package.
      const everything = readdirSync(path.join(dir, 'native', HOST_TARGET), { recursive: true }).map(String);
      expect(everything.filter((name) => name.endsWith('.pdb'))).toEqual([]);
      expect(readFileSync(path.join(dir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toContain(
        `${pinned.package} ${pins.version}`,
      );
      await h.close();
    },
    BUNDLE_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-01 the loader requires native/<host> by path from the bundle, and the fake claude starts, resizes, exits and is killed through it (inbox console host)',
    async () => {
      const h = start({ route: 'direct' });
      const { dir } = await buildBundle(h, ['--native-targets', HOST_TARGET]);
      let own: ProcessRow[] = [];
      let withSession: ProcessRow[] = [];
      const run = await runProbe(h, dir, 'inbox', {
        atLoaded: async (probePid) => {
          own = consoleHostsOf(await listProcesses(), probePid);
        },
        atReady: async (probePid) => {
          withSession = consoleHostsOf(await listProcesses(), probePid);
        },
      });
      await expectProbeSucceeded(h, run);
      // The session of the probe sat in a console hosted by the inbox conhost.exe (the probe has a hidden console of its own).
      expect(addedHosts(own, withSession).map((row) => row.name.toLowerCase())).toEqual(['conhost.exe']);
      await h.close();
    },
    BUNDLE_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-01 with the bundled conpty.dll the console host is the bundled OpenConsole.exe, run from the bundle folder, and it is the pinned file',
    async () => {
      const h = start({ route: 'direct' });
      const { dir } = await buildBundle(h, ['--native-targets', HOST_TARGET]);
      const bundled = path.join(dir, 'native', HOST_TARGET, 'prebuilds', HOST_TARGET, 'conpty', 'OpenConsole.exe');
      let own: ProcessRow[] = [];
      let withSession: ProcessRow[] = [];
      const run = await runProbe(h, dir, 'dll', {
        atLoaded: async (probePid) => {
          own = consoleHostsOf(await listProcesses(), probePid);
        },
        atReady: async (probePid) => {
          withSession = consoleHostsOf(await listProcesses(), probePid);
        },
      });
      await expectProbeSucceeded(h, run);
      const hosts = addedHosts(own, withSession).map((row) => ({ name: row.name, file: row.path }));

      expect(hosts).toHaveLength(1);
      expect(hosts[0]?.name).toBe('OpenConsole.exe');
      // The file that hosted the console is the one in the bundle (compared as real paths, without regard to case), and it is the
      // file of the pin: the signed binary of Microsoft, byte for byte.
      expect(path.resolve(hosts[0]?.file ?? '').toLowerCase()).toBe(path.resolve(bundled).toLowerCase());
      const pin = readPins().targets[HOST_TARGET]?.binary[`prebuilds/${HOST_TARGET}/conpty/OpenConsole.exe`];
      expect(pin).toBeDefined();
      expect(sha256(readFileSync(bundled))).toBe(pin?.sha256);
      await h.close();
    },
    BUNDLE_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-01 a bundle built without native files has no fallback: the backend says native-missing and starts nothing',
    async () => {
      const h = start({ route: 'direct' });
      const { dir } = await buildBundle(h, ['--no-native']);
      expect(existsSync(path.join(dir, 'native'))).toBe(false);
      const run = await runProbe(h, dir, 'missing');
      // The probe sits in the repository's tree of sources, where node_modules has the package: a bundle layout must not use it.
      expect(run.stderr).toBe('');
      expect(run.code).toBe(0);
      expect(run.events.map((e) => ({ event: e.event, ...e.fields }))).toEqual([
        { event: 'unsupported', reason: 'native-missing' },
      ]);
      await h.close();
    },
    BUNDLE_TEST_TIMEOUT_MS,
  );

  it(
    'TC-PTY-01 arm64: no binary is executed; the pins, the lockfile and the hashes of an offline copy agree',
    () => {
      const pins = readPins();
      const lock = LockSchema.parse(JSON.parse(readFileSync(path.join(RUNTIME_ROOT, 'package-lock.json'), 'utf8')));
      expect([...SHIPPED_TARGETS].sort()).toEqual(Object.keys(pins.targets).sort());
      expect(SHIPPED_TARGETS).toContain('win32-arm64');
      expect(targetOf(hostPlatform, 'arm64')).toBe('win32-arm64');

      const reference = pins.targets['win32-x64'];
      for (const target of SHIPPED_TARGETS) {
        const pinned = pins.targets[target];
        if (pinned === undefined || reference === undefined) throw new Error(`the pins have no target ${target}`);
        // The same four binaries for every Windows target, each with a size and a sha256 of its own.
        expect(Object.keys(pinned.binary).sort(), target).toEqual(
          Object.keys(reference.binary)
            .map((rel) => rel.replace('win32-x64', target))
            .sort(),
        );
        for (const [rel, pin] of Object.entries(pinned.binary))
          expect(pin.sha256, `${target} ${rel}`).toMatch(/^[0-9a-f]{64}$/);
        // The lockfile holds the same package at the same version with the same integrity as the pin.
        const locked = lock.packages[`node_modules/${pinned.package}`];
        expect(locked?.version, target).toBe(pins.version);
        expect(locked?.integrity, target).toBe(pinned.integrity);
        expect(pinned.package).toBe(`@lydell/node-pty-${target}`);

        // A copy of the package that is already on this machine (installed, or staged earlier): its files must have the pinned
        // size and hash. A target that has no offline copy here is covered by the integrity of the lockfile above.
        const copies = [
          path.join(RUNTIME_ROOT, 'node_modules', ...pinned.package.split('/')),
          path.join(RUNTIME_ROOT, 'node_modules', '.cache', 'mcs-native', `lydell-node-pty-${target}-${pins.version}`),
        ];
        const copy = copies.find((candidate) => existsSync(candidate));
        if (copy === undefined) continue;
        for (const [rel, pin] of Object.entries(pinned.binary)) {
          const bytes = readFileSync(path.join(copy, ...rel.split('/')));
          expect(bytes.length, `${target} ${rel}`).toBe(pin.bytes);
          expect(sha256(bytes), `${target} ${rel}`).toBe(pin.sha256);
        }
      }
    },
    PER_TEST_TIMEOUT_MS,
  );
});
