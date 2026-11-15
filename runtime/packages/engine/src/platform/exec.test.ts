import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHILD_KINDS } from '@mcs/shared';
import { useTempDirs, waitFor } from '@mcs/testkit';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_STDIN_BYTES,
  buildChildEnv,
  childStats,
  createResolver,
  execFileText,
  firstLine,
  powershellEncodedArgs,
  resolveExecutable,
  setChildLogSink,
  spawnDetached,
  spawnDetachedVisible,
  spawnErrorCode,
  spawnForeground,
  spawnRefusal,
  type ChildLogEntry,
  type ChildSpec,
  type ResolverDeps,
} from './exec.ts';
import { pidAlive } from './process.ts';

const NODE = process.execPath;
const isWin = process.platform === 'win32';
/** The git smoke test needs a git on PATH; the resolver logic itself is covered with injected dependencies. */
const gitInstalled = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const makeTemp = useTempDirs();

afterEach(() => {
  setChildLogSink(null);
});

/** A `node -e <code> -- <args>` child. */
function node(code: string, extra: Partial<ChildSpec> = {}, args: readonly string[] = []): ChildSpec {
  return {
    kind: 'node',
    file: NODE,
    args: ['-e', code, '--', ...args],
    timeoutMs: 20_000,
    maxOutputBytes: 1_048_576,
    encoding: 'utf8',
    ...extra,
  };
}

describe('execFileText: arguments, output and exit codes', () => {
  it('passes argv with spaces, quotes and shell metacharacters to the child verbatim', async () => {
    const tricky = [
      'plain',
      'with space',
      'say "hi"',
      "it's",
      'a&b|c;d>e<f',
      '%PATH%',
      '$HOME `id` $(id)',
      '^caret',
      '(paren) [bracket] {brace}',
      'tab\there',
      'back\\slash',
      'trailing\\',
      'C:\\Program Files\\x y\\',
      'two  spaces',
      '',
      'unicode-\u00e9\u65e5\u672c',
      '--flag=value with space',
      '*.log',
    ];
    const result = await execFileText(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', {}, tricky));
    expect(result.error).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual(tricky);
  });

  it('returns ok with stdout and stderr kept apart', async () => {
    const result = await execFileText(node("process.stdout.write('out'); process.stderr.write('err')"));
    expect(result).toMatchObject({ ok: true, code: 0, stdout: 'out', stderr: 'err', error: null, truncated: false });
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('decodes as latin1 or utf8 as asked', async () => {
    const code = 'process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xe9]))';
    expect((await execFileText(node(code, { encoding: 'latin1' }))).stdout).toBe('caf\u00e9');
    expect((await execFileText(node(code, { encoding: 'utf8' }))).stdout).toBe('caf\ufffd');
    const text = 'process.stdout.write(Buffer.from("h\\u00e9llo \\u65e5\\u672c", "utf8"))';
    expect((await execFileText(node(text))).stdout).toBe('h\u00e9llo \u65e5\u672c');
  });

  it('reports a non-zero exit as NONZERO_EXIT with the code and the output', async () => {
    const result = await execFileText(node("process.stderr.write('boom'); process.exit(3)"));
    expect(result).toMatchObject({ ok: false, code: 3, stderr: 'boom', error: 'NONZERO_EXIT', truncated: false });
  });

  it('reports a missing program as ENOENT without throwing', async () => {
    const missing = path.join(makeTemp('exec').path, isWin ? 'no-such-program.exe' : 'no-such-program');
    const result = await execFileText({ ...node('0'), file: missing });
    expect(result).toMatchObject({ ok: false, code: null, error: 'ENOENT', stdout: '', stderr: '' });
  });

  it('maps spawn errors to the closed set of codes', () => {
    expect(spawnErrorCode('ENOENT')).toBe('ENOENT');
    expect(spawnErrorCode('EACCES')).toBe('EACCES');
    expect(spawnErrorCode('EPERM')).toBe('EACCES');
    expect(spawnErrorCode('EINVAL')).toBe('SPAWN_FAILED');
    expect(spawnErrorCode('EMFILE')).toBe('SPAWN_FAILED');
    expect(spawnErrorCode(undefined)).toBe('SPAWN_FAILED');
  });

  it('runs in the given working directory', async () => {
    const dir = makeTemp('exec').path;
    const result = await execFileText(node('process.stdout.write(process.cwd())', { cwd: dir }));
    expect(path.resolve(result.stdout).toLowerCase()).toBe(path.resolve(dir).toLowerCase());
  });
});

describe('execFileText: limits', () => {
  it('kills the child at the timeout and reports TIMEOUT, with no process left', async () => {
    const before = childStats().node;
    const started = performance.now();
    const result = await execFileText(
      node('process.stdout.write(String(process.pid) + "\\n"); setInterval(() => undefined, 1000)', {
        timeoutMs: 2500,
      }),
    );
    expect(result).toMatchObject({ ok: false, code: null, error: 'TIMEOUT' });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(result.durationMs).toBeGreaterThanOrEqual(2400);
    const pid = Number.parseInt(result.stdout, 10);
    expect(Number.isInteger(pid)).toBe(true);
    await waitFor(() => !pidAlive(pid), { timeoutMs: 5000, what: 'the timed-out child to be gone' });
    const after = childStats().node;
    expect(after.timedOut).toBe(before.timedOut + 1);
    expect(after.failed).toBe(before.failed + 1);
  });

  it('kills a child that writes more than maxOutputBytes and reports OUTPUT_LIMIT', async () => {
    const code = [
      'process.stdout.write(String(process.pid) + "\\n");',
      'const chunk = Buffer.alloc(65536, 97);',
      'let n = 0;',
      'const t = setInterval(() => { for (let i = 0; i < 16; i += 1) process.stdout.write(chunk); if (++n > 200) clearInterval(t); }, 5);',
    ].join(' ');
    const result = await execFileText(node(code, { maxOutputBytes: 1_048_576, timeoutMs: 30_000 }));
    expect(result).toMatchObject({ ok: false, code: null, error: 'OUTPUT_LIMIT', truncated: true });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_048_576);
    const pid = Number.parseInt(result.stdout, 10);
    await waitFor(() => !pidAlive(pid), { timeoutMs: 5000, what: 'the noisy child to be gone' });
  });

  it('counts stdout and stderr together against the cap', async () => {
    const code = [
      'const half = Buffer.alloc(600000, 97);',
      'process.stdout.write(half);',
      'process.stderr.write(half);',
      'setInterval(() => undefined, 1000);',
    ].join(' ');
    const result = await execFileText(node(code, { maxOutputBytes: 1_048_576 }));
    expect(result).toMatchObject({ error: 'OUTPUT_LIMIT', truncated: true, ok: false });
  });

  it('accepts exactly maxOutputBytes and rejects one byte more', async () => {
    const exact = await execFileText(node('process.stdout.write("x".repeat(1000))', { maxOutputBytes: 1000 }));
    expect(exact).toMatchObject({ ok: true, truncated: false, error: null });
    expect(exact.stdout).toHaveLength(1000);
    const over = await execFileText(node('process.stdout.write("x".repeat(1001))', { maxOutputBytes: 1000 }));
    expect(over).toMatchObject({ ok: false, truncated: true, error: 'OUTPUT_LIMIT' });
    expect(over.stdout.length).toBeLessThanOrEqual(1000);
  });

  it('refuses nonsense limits without spawning or throwing', async () => {
    const before = childStats().node.spawned;
    for (const spec of [
      node('0', { timeoutMs: 0 }),
      node('0', { timeoutMs: -5 }),
      node('0', { timeoutMs: Number.NaN }),
      node('0', { maxOutputBytes: 0 }),
      node('0', { maxOutputBytes: Number.POSITIVE_INFINITY }),
    ]) {
      expect(await execFileText(spec)).toMatchObject({ ok: false, error: 'SPAWN_FAILED' });
    }
    expect(childStats().node.spawned).toBe(before);
  });

  it('answers an oversize command line with a failed result, never an exception', async () => {
    const result = await execFileText(node('0', {}, ['x'.repeat(200_000)]));
    expect(result.ok).toBe(false);
    expect(['SPAWN_FAILED', 'NONZERO_EXIT']).toContain(result.error);
  });

  it('turns an argument that the OS cannot carry (NUL) into SPAWN_FAILED instead of throwing', async () => {
    const result = await execFileText(node('0', {}, ['a\u0000b']));
    expect(result).toMatchObject({ ok: false, error: 'SPAWN_FAILED' });
  });
});

describe('execFileText: refusals (security rules 1 and 2)', () => {
  it('spawnRefusal: Windows needs an absolute path to a .exe or .com, never .cmd or .bat', () => {
    expect(spawnRefusal('C:\\Windows\\System32\\taskkill.exe', 'win32')).toBeNull();
    expect(spawnRefusal('C:\\tools\\TOOL.EXE', 'win32')).toBeNull();
    expect(spawnRefusal('C:\\tools\\old.com', 'win32')).toBeNull();
    expect(spawnRefusal('\\\\server\\share\\x.exe', 'win32')).toBeNull();
    expect(spawnRefusal('C:\\tools\\run.cmd', 'win32')).not.toBeNull();
    expect(spawnRefusal('C:\\tools\\RUN.BAT', 'win32')).not.toBeNull();
    expect(spawnRefusal('C:\\tools\\run.ps1', 'win32')).not.toBeNull();
    expect(spawnRefusal('C:\\tools\\noext', 'win32')).not.toBeNull();
    expect(spawnRefusal('tool.exe', 'win32')).not.toBeNull();
    expect(spawnRefusal('.\\tool.exe', 'win32')).not.toBeNull();
    expect(spawnRefusal('', 'win32')).not.toBeNull();
  });

  it('spawnRefusal: other platforms need an absolute path and nothing else', () => {
    expect(spawnRefusal('/usr/bin/git', 'linux')).toBeNull();
    expect(spawnRefusal('/opt/tool.cmd', 'linux')).toBeNull();
    expect(spawnRefusal('git', 'linux')).not.toBeNull();
    expect(spawnRefusal('./git', 'darwin')).not.toBeNull();
    expect(spawnRefusal('', 'linux')).not.toBeNull();
    expect(spawnRefusal('/usr/bin/git\u0000x', 'linux')).not.toBeNull();
  });

  it('answers a relative file with SPAWN_FAILED, counted as failed and not as spawned', async () => {
    const before = childStats().node;
    const result = await execFileText({ ...node('0'), file: 'node' });
    expect(result).toMatchObject({ ok: false, code: null, error: 'SPAWN_FAILED', durationMs: 0 });
    const after = childStats().node;
    expect(after.spawned).toBe(before.spawned);
    expect(after.failed).toBe(before.failed + 1);
  });

  it.runIf(isWin)('answers a .cmd file with SPAWN_FAILED on Windows (a shell would be needed)', async () => {
    const dir = makeTemp('exec').path;
    const cmd = path.join(dir, 'tool.cmd');
    const result = await execFileText({ ...node('0'), file: cmd });
    expect(result).toMatchObject({ ok: false, error: 'SPAWN_FAILED' });
  });
});

describe('execFileText: environment (security rules 3 and 4)', () => {
  const source = {
    PATH: '/bin',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\t',
    TMP: 'C:\\t2',
    HOME: '/home/x',
    USERPROFILE: 'C:\\Users\\x',
    LANG: 'en_US.UTF-8',
    GIT_DIR: '/elsewhere',
    GIT_WORK_TREE: '/w',
    GIT_INDEX_FILE: '/i',
    SECRET_TOKEN: 'shh',
    MCS_HOME: '/mcs',
    DOCKER_HOST: 'tcp://127.0.0.1:2375',
    DOCKER_CONTEXT: 'ctx',
    DOCKER_CONFIG: '/dc',
  };

  it('starts from the allow-list and adds MCS_HOOK_DISABLE=1', () => {
    const env = buildChildEnv('node', undefined, source, 'win32');
    expect(env).toEqual({
      PATH: '/bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\t',
      TMP: 'C:\\t2',
      HOME: '/home/x',
      USERPROFILE: 'C:\\Users\\x',
      LANG: 'en_US.UTF-8',
      MCS_HOOK_DISABLE: '1',
    });
  });

  it('omits allow-listed names that are not set instead of passing undefined', () => {
    const env = buildChildEnv('node', undefined, { PATH: '/bin' }, 'linux');
    expect(Object.keys(env).sort()).toEqual(['LC_ALL', 'MCS_HOOK_DISABLE', 'PATH']);
  });

  it('never passes GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE, and git adds its two switches', () => {
    for (const kind of CHILD_KINDS) {
      const env = buildChildEnv(kind, undefined, source, 'win32');
      expect(env).not.toHaveProperty('GIT_DIR');
      expect(env).not.toHaveProperty('GIT_WORK_TREE');
      expect(env).not.toHaveProperty('GIT_INDEX_FILE');
      expect(env).not.toHaveProperty('SECRET_TOKEN');
      expect(env['MCS_HOOK_DISABLE']).toBe('1');
      if (kind === 'git') {
        expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
        expect(env['GIT_OPTIONAL_LOCKS']).toBe('0');
      } else {
        expect(env).not.toHaveProperty('GIT_TERMINAL_PROMPT');
        expect(env).not.toHaveProperty('GIT_OPTIONAL_LOCKS');
      }
    }
  });

  it('passes the docker selectors through only for kind docker, and only when set', () => {
    const docker = buildChildEnv('docker', undefined, source, 'win32');
    expect(docker).toMatchObject({ DOCKER_HOST: 'tcp://127.0.0.1:2375', DOCKER_CONTEXT: 'ctx', DOCKER_CONFIG: '/dc' });
    expect(buildChildEnv('node', undefined, source, 'win32')).not.toHaveProperty('DOCKER_HOST');
    const partial = buildChildEnv('docker', undefined, { PATH: '/bin', DOCKER_CONTEXT: 'x' }, 'win32');
    expect(partial['DOCKER_CONTEXT']).toBe('x');
    expect(partial).not.toHaveProperty('DOCKER_HOST');
    expect(partial).not.toHaveProperty('DOCKER_CONFIG');
  });

  it('adds LC_ALL=C on POSIX only', () => {
    expect(buildChildEnv('ps', undefined, source, 'linux')['LC_ALL']).toBe('C');
    expect(buildChildEnv('ps', undefined, source, 'darwin')['LC_ALL']).toBe('C');
    expect(buildChildEnv('ps', undefined, source, 'win32')).not.toHaveProperty('LC_ALL');
  });

  it('applies extraEnv last: it can add and override, never remove an allow-list entry', () => {
    const env = buildChildEnv('node', { MY_FLAG: 'on', PATH: '/custom', MCS_HOOK_DISABLE: '0' }, source, 'win32');
    expect(env['MY_FLAG']).toBe('on');
    expect(env['PATH']).toBe('/custom');
    expect(env['MCS_HOOK_DISABLE']).toBe('0');
    expect(env['SystemRoot']).toBe('C:\\Windows');
    const plain = buildChildEnv('node', {}, source, 'win32');
    expect(plain['PATH']).toBe('/bin');
  });

  it('a real child sees the minimal environment: no GIT_DIR, no foreign variable, hooks disabled', async () => {
    vi.stubEnv('GIT_DIR', 'D:\\somewhere\\.git');
    vi.stubEnv('MCS_SECRET_PROBE', 'must-not-leak');
    vi.stubEnv('MCS_HOOK_DISABLE', '0');
    const result = await execFileText(
      node('process.stdout.write(JSON.stringify(process.env))', { extraEnv: { FROM_EXTRA: 'yes' } }),
    );
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(env['MCS_HOOK_DISABLE']).toBe('1');
    expect(env['FROM_EXTRA']).toBe('yes');
    expect(Object.keys(env).map((key) => key.toLowerCase())).not.toContain('git_dir');
    expect(Object.keys(env)).not.toContain('MCS_SECRET_PROBE');
    expect(Object.keys(env).map((key) => key.toLowerCase())).toContain('path');
  });

  it('kind git gets the lock-free switches in a real child', async () => {
    const result = await execFileText(
      node('process.stdout.write([process.env.GIT_OPTIONAL_LOCKS, process.env.GIT_TERMINAL_PROMPT].join(","))', {
        kind: 'git',
      }),
    );
    expect(result.stdout).toBe('0,0');
  });
});

describe('execFileText: stdin (registry C60)', () => {
  const echo =
    'let d = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { d += c; }); process.stdin.on("end", () => process.stdout.write(d));';

  it('writes the string once to a kind node child and closes the stream', async () => {
    const payload = '{"hook":"probe","text":"h\u00e9llo w\u00f6rld \u65e5\u672c"}';
    const result = await execFileText(node(echo, { stdin: payload }));
    expect(result).toMatchObject({ ok: true, stdout: payload });
  });

  it('accepts an empty string and exactly 4096 bytes of UTF-8', async () => {
    expect(MAX_STDIN_BYTES).toBe(4096);
    expect((await execFileText(node(echo, { stdin: '' }))).stdout).toBe('');
    const exact = '\u00e9'.repeat(2048);
    expect(Buffer.byteLength(exact)).toBe(4096);
    expect((await execFileText(node(echo, { stdin: exact }))).stdout).toBe(exact);
    expect((await execFileText(node(echo, { stdin: 'x'.repeat(4096) }))).stdout).toHaveLength(4096);
  });

  it('refuses 4097 bytes with SPAWN_FAILED and spawns nothing', async () => {
    const before = childStats().node;
    for (const stdin of ['x'.repeat(4097), '\u00e9'.repeat(2049)]) {
      expect(await execFileText(node(echo, { stdin }))).toMatchObject({ ok: false, error: 'SPAWN_FAILED' });
    }
    const after = childStats().node;
    expect(after.spawned).toBe(before.spawned);
    expect(after.failed).toBe(before.failed + 2);
  });

  it('refuses stdin for every kind except node', async () => {
    for (const kind of CHILD_KINDS) {
      if (kind === 'node') continue;
      const before = childStats()[kind].spawned;
      const result = await execFileText(node(echo, { kind, stdin: 'x' }));
      expect(result).toMatchObject({ ok: false, error: 'SPAWN_FAILED' });
      expect(childStats()[kind].spawned).toBe(before);
    }
  });

  it('ignores EPIPE from a child that exits without reading its stdin', async () => {
    for (let i = 0; i < 5; i += 1) {
      const result = await execFileText(node('process.exit(0)', { stdin: 'x'.repeat(4096) }));
      expect(result).toMatchObject({ ok: true, error: null });
    }
  });

  it('gives a child without stdin an immediately closed input', async () => {
    const result = await execFileText(
      node('process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume();'),
    );
    expect(result.stdout).toBe('eof');
  });
});

describe('execFileText: concurrency (rule 7)', () => {
  it('runs at most 2 children, queues 8 in order, and answers the 11th request QUEUE_FULL at once', async () => {
    const code =
      'const s = Date.now(); setTimeout(() => process.stdout.write(JSON.stringify({ s, e: Date.now() })), 250);';
    const before = childStats().node;
    const started = performance.now();
    const calls = Array.from({ length: 11 }, () => execFileText(node(code)));
    const results = await Promise.all(calls);
    const total = performance.now() - started;

    expect(results[10]).toMatchObject({ ok: false, error: 'QUEUE_FULL', durationMs: 0, code: null });
    for (const result of results.slice(0, 10)) expect(result).toMatchObject({ ok: true, error: null });

    const windows = results.slice(0, 10).map((result) => JSON.parse(result.stdout) as { s: number; e: number });
    // The sweep line over the children's own start and end times: never more than two at once.
    const edges = windows.flatMap(({ s, e }) => [
      { t: s, d: 1 },
      { t: e, d: -1 },
    ]);
    edges.sort((a, b) => a.t - b.t || a.d - b.d);
    let live = 0;
    let peak = 0;
    for (const edge of edges) {
      live += edge.d;
      peak = Math.max(peak, live);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(2);
    // FIFO: a request starts only after the request two places ahead of it has ended.
    for (let i = 2; i < windows.length; i += 1) {
      expect(windows[i]?.s ?? 0).toBeGreaterThanOrEqual((windows[i - 2]?.s ?? 0) + 200);
    }
    // 10 children in 5 waves of at least 250 ms.
    expect(total).toBeGreaterThanOrEqual(1200);

    const after = childStats().node;
    expect(after.spawned).toBe(before.spawned + 10);
    expect(after.failed).toBe(before.failed + 1);
  }, 60_000);

  it('releases the slot after every kind of failure, so later requests still run', async () => {
    const missing = path.join(makeTemp('exec').path, isWin ? 'gone.exe' : 'gone');
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => execFileText({ ...node('0'), file: missing })),
      ...Array.from({ length: 2 }, () => execFileText(node('process.exit(9)'))),
      ...Array.from({ length: 2 }, () => execFileText(node('setInterval(() => undefined, 1000)', { timeoutMs: 400 }))),
    ]);
    expect(results.map((result) => result.error)).toEqual([
      'ENOENT',
      'ENOENT',
      'ENOENT',
      'ENOENT',
      'ENOENT',
      'ENOENT',
      'NONZERO_EXIT',
      'NONZERO_EXIT',
      'TIMEOUT',
      'TIMEOUT',
    ]);
    const after = await Promise.all([
      execFileText(node('process.stdout.write("a")')),
      execFileText(node('process.stdout.write("b")')),
    ]);
    expect(after.map((result) => result.stdout)).toEqual(['a', 'b']);
  }, 60_000);

  it('is not affected by changes the caller makes to its request while it waits in the queue', async () => {
    const hold = 'setTimeout(() => undefined, 500);';
    const first = execFileText(node(hold));
    const second = execFileText(node(hold));
    const spec = node(
      'process.stdout.write(process.argv[1] + ":" + process.env.FLAVOR)',
      { extraEnv: { FLAVOR: 'original' } },
      ['original'],
    );
    const queued = execFileText(spec);
    (spec.args as string[])[3] = 'mutated';
    (spec.extraEnv as Record<string, string>)['FLAVOR'] = 'mutated';
    expect((await queued).stdout).toBe('original:original');
    await Promise.all([first, second]);
  }, 30_000);

  it('settles shortly after the child exits even when a grandchild still holds its pipes', async () => {
    const code =
      'const { spawn } = require("node:child_process");' +
      ' spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { stdio: "inherit" }).unref();' +
      ' process.stdout.write("parent done");';
    const started = performance.now();
    const result = await execFileText(node(code));
    expect(result).toMatchObject({ ok: true, stdout: 'parent done' });
    expect(performance.now() - started).toBeLessThan(2300);
  }, 30_000);

  it('lets a request go as soon as a slot frees up after QUEUE_FULL', async () => {
    const result = await execFileText(node('process.stdout.write("again")'));
    expect(result).toMatchObject({ ok: true, stdout: 'again' });
  });
});

describe('execFileText: AbortSignal', () => {
  it('answers ABORTED without spawning when the signal is already aborted', async () => {
    const before = childStats().node.spawned;
    const result = await execFileText(node('0'), AbortSignal.abort());
    expect(result).toMatchObject({ ok: false, code: null, error: 'ABORTED' });
    expect(childStats().node.spawned).toBe(before);
  });

  it('kills a running child on abort', async () => {
    const pidFile = path.join(makeTemp('exec').path, 'child.pid');
    const controller = new AbortController();
    const pending = execFileText(
      node(
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => undefined, 1000)',
        {},
        [pidFile],
      ),
      controller.signal,
    );
    const pid = Number.parseInt(
      await waitFor(
        () => {
          const text = readFileSync(pidFile, 'utf8');
          return text === '' ? null : text;
        },
        { timeoutMs: 10_000, what: 'the child to report its pid' },
      ),
      10,
    );
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: null, error: 'ABORTED' });
    await waitFor(() => !pidAlive(pid), { timeoutMs: 5000, what: 'the aborted child to be gone' });
  }, 30_000);

  it('removes a queued request on abort without disturbing the running ones', async () => {
    const hold = 'setTimeout(() => undefined, 900);';
    const before = childStats().node.spawned;
    const first = execFileText(node(hold));
    const second = execFileText(node(hold));
    const controller = new AbortController();
    const queued = execFileText(node(hold), controller.signal);
    controller.abort();
    const aborted = await queued;
    expect(aborted).toMatchObject({ ok: false, error: 'ABORTED' });
    expect(aborted.durationMs).toBe(0);
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(childStats().node.spawned).toBe(before + 2);
  }, 30_000);
});

describe('childStats', () => {
  it('has every kind, each with the four counters, and returns a copy', () => {
    const stats = childStats();
    expect(Object.keys(stats).sort()).toEqual([...CHILD_KINDS].sort());
    for (const kind of ['powershell.shortcut', 'claude', 'powershell.picker'] as const) {
      // Nothing in this file spawns them (an earlier case refuses stdin for them, which counts as failed).
      expect(stats[kind].spawned, kind).toBe(0);
      expect(stats[kind].totalMs, kind).toBe(0);
    }
    for (const kind of CHILD_KINDS) {
      expect(Object.keys(stats[kind]).sort()).toEqual(['failed', 'spawned', 'timedOut', 'totalMs']);
      expect(stats[kind].spawned).toBeGreaterThanOrEqual(0);
    }
    stats.node.spawned = 99_999;
    expect(childStats().node.spawned).not.toBe(99_999);
  });

  it('counts spawned, failed and the time of a run', async () => {
    const before = childStats().node;
    await execFileText(node('0'));
    await execFileText(node('process.exit(2)'));
    const after = childStats().node;
    expect(after.spawned).toBe(before.spawned + 2);
    expect(after.failed).toBe(before.failed + 1);
    expect(after.timedOut).toBe(before.timedOut);
    expect(after.totalMs).toBeGreaterThan(before.totalMs);
  });

  it('does not count an abort by the caller as a failure', async () => {
    const before = childStats().node.failed;
    await execFileText(node('0'), AbortSignal.abort());
    expect(childStats().node.failed).toBe(before);
  });
});

describe('setChildLogSink (rule 9: one debug line per spawn, no arguments, no output)', () => {
  it('reports kind, duration, exit code and error for each spawned child and nothing else', async () => {
    const entries: ChildLogEntry[] = [];
    setChildLogSink((entry) => entries.push(entry));
    await execFileText(node("process.stdout.write('secret-output')", {}, ['secret-arg']));
    await execFileText(node('process.exit(4)'));
    expect(entries).toHaveLength(2);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(['code', 'durationMs', 'error', 'kind']);
    expect(entries[0]).toMatchObject({ kind: 'node', code: 0, error: null });
    expect(entries[1]).toMatchObject({ kind: 'node', code: 4, error: 'NONZERO_EXIT' });
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('does not log a refused request and survives a throwing sink', async () => {
    const entries: ChildLogEntry[] = [];
    setChildLogSink((entry) => entries.push(entry));
    await execFileText({ ...node('0'), file: 'relative' });
    expect(entries).toEqual([]);
    setChildLogSink(() => {
      throw new Error('sink bug');
    });
    expect((await execFileText(node('0'))).ok).toBe(true);
  });
});

describe('powershellEncodedArgs and firstLine', () => {
  it('builds the fixed -EncodedCommand argument list from a UTF-16LE base64 script', () => {
    const script = "Write-Output 'h\u00e9llo \u65e5\u672c'";
    const args = powershellEncodedArgs(script);
    expect(args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
    ]);
    expect(args).toHaveLength(6);
    expect(Buffer.from(args[5] ?? '', 'base64').toString('utf16le')).toBe(script);
    expect(args.join(' ')).not.toContain('-Command ');
  });

  it('firstLine keeps the first non-empty line, clipped to 200 characters by default', () => {
    expect(firstLine('a\r\nb')).toBe('a');
    expect(firstLine('\n  err message  \nmore')).toBe('err message');
    expect(firstLine('')).toBe('');
    expect(firstLine('   ')).toBe('');
    expect(firstLine('x'.repeat(300))).toHaveLength(200);
    expect(firstLine('abcdef', 3)).toBe('abc');
    expect(firstLine('\u{1f600}\u{1f600}\u{1f600}', 2)).toBe('\u{1f600}\u{1f600}');
  });
});

function resolverRig(
  platform: ResolverDeps['platform'],
  files: readonly string[],
  env: Record<string, string | undefined>,
) {
  const present = new Set(files);
  const calls: string[] = [];
  const clock = { t: 0 };
  const deps: ResolverDeps = {
    platform,
    env: (name) => env[name],
    execPath: platform === 'win32' ? 'C:\\node\\node.exe' : '/usr/bin/node',
    exists: (file) => {
      calls.push(file);
      return Promise.resolve(present.has(file));
    },
    isExecutable: (file) => {
      calls.push(file);
      return Promise.resolve(present.has(file));
    },
    now: () => clock.t,
  };
  return { resolve: createResolver(deps), calls, clock, present };
}

describe('createResolver on Windows', () => {
  const root = { SystemRoot: 'C:\\Windows' };
  const system = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\taskkill.exe',
    'C:\\Windows\\System32\\icacls.exe',
    'C:\\Windows\\explorer.exe',
  ];

  it('uses the fixed system paths and process.execPath', async () => {
    const { resolve } = resolverRig('win32', system, root);
    expect(await resolve('powershell')).toBe(system[0]);
    expect(await resolve('taskkill')).toBe(system[1]);
    expect(await resolve('icacls')).toBe(system[2]);
    expect(await resolve('opener')).toBe(system[3]);
    expect(await resolve('node')).toBe('C:\\node\\node.exe');
    expect(await resolve('ps')).toBeNull();
  });

  it('checks that the fixed file exists and falls back to windir when SystemRoot is missing', async () => {
    const missing = resolverRig('win32', [], root);
    expect(await missing.resolve('powershell')).toBeNull();
    expect(await missing.resolve('node')).toBe('C:\\node\\node.exe');
    const windir = resolverRig('win32', system, { windir: 'C:\\Windows' });
    expect(await windir.resolve('taskkill')).toBe(system[1]);
    const none = resolverRig('win32', system, {});
    expect(await none.resolve('taskkill')).toBeNull();
  });

  it('searches PATH: split on ;, quotes trimmed, relative entries ignored, first hit wins', async () => {
    const { resolve } = resolverRig(
      'win32',
      ['C:\\Tools\\git.exe', 'C:\\b\\git.exe', 'rel\\dir\\git.exe', 'C:\\Tools\\docker.exe'],
      {
        ...root,
        PATH: 'C:\\a;"C:\\Tools";rel\\dir;;  ;C:\\b',
      },
    );
    expect(await resolve('git')).toBe('C:\\Tools\\git.exe');
    expect(await resolve('docker')).toBe('C:\\Tools\\docker.exe');
  });

  it('gives null when PATH is missing or has no hit', async () => {
    expect(await resolverRig('win32', [], { ...root, PATH: 'C:\\a' }).resolve('git')).toBeNull();
    expect(await resolverRig('win32', ['C:\\a\\git.exe'], root).resolve('git')).toBeNull();
  });

  it('swaps the Git cmd shim for mingw64\\bin\\git.exe when that file exists', async () => {
    const shim = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const real = 'C:\\Program Files\\Git\\mingw64\\bin\\git.exe';
    const swapped = resolverRig('win32', [shim, real], { ...root, PATH: 'C:\\Program Files\\Git\\cmd' });
    expect(await swapped.resolve('git')).toBe(real);
    const kept = resolverRig('win32', [shim], { ...root, PATH: 'C:\\Program Files\\Git\\cmd' });
    expect(await kept.resolve('git')).toBe(shim);
    const upper = resolverRig('win32', ['C:\\GIT\\CMD\\git.exe', 'C:\\GIT\\mingw64\\bin\\git.exe'], {
      ...root,
      PATH: 'C:\\GIT\\CMD',
    });
    expect(await upper.resolve('git')).toBe('C:\\GIT\\mingw64\\bin\\git.exe');
    const direct = resolverRig('win32', ['C:\\Git\\mingw64\\bin\\git.exe'], { ...root, PATH: 'C:\\Git\\mingw64\\bin' });
    expect(await direct.resolve('git')).toBe('C:\\Git\\mingw64\\bin\\git.exe');
  });

  it('caches a hit for 10 minutes and a miss for 5 minutes', async () => {
    const hit = resolverRig('win32', ['C:\\Tools\\git.exe'], { ...root, PATH: 'C:\\Tools' });
    await hit.resolve('git');
    const afterFirst = hit.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    hit.clock.t = 10 * 60_000 - 1;
    await hit.resolve('git');
    expect(hit.calls.length).toBe(afterFirst);
    hit.clock.t = 10 * 60_000 + 1;
    await hit.resolve('git');
    expect(hit.calls.length).toBeGreaterThan(afterFirst);

    const miss = resolverRig('win32', [], { ...root, PATH: 'C:\\Tools' });
    expect(await miss.resolve('docker')).toBeNull();
    const missCalls = miss.calls.length;
    miss.present.add('C:\\Tools\\docker.exe');
    miss.clock.t = 5 * 60_000 - 1;
    expect(await miss.resolve('docker')).toBeNull();
    expect(miss.calls.length).toBe(missCalls);
    miss.clock.t = 5 * 60_000 + 1;
    expect(await miss.resolve('docker')).toBe('C:\\Tools\\docker.exe');
  });
});

describe('createResolver on POSIX', () => {
  it('finds the first PATH entry with an executable and ignores relative entries', async () => {
    const { resolve } = resolverRig('linux', ['/usr/bin/git', '/usr/local/bin/docker', '/usr/bin/ps', 'rel/git'], {
      PATH: 'rel:/opt/none:/usr/local/bin:/usr/bin',
    });
    expect(await resolve('git')).toBe('/usr/bin/git');
    expect(await resolve('docker')).toBe('/usr/local/bin/docker');
    expect(await resolve('ps')).toBe('/usr/bin/ps');
    expect(await resolve('node')).toBe('/usr/bin/node');
  });

  it('has no powershell, taskkill or icacls', async () => {
    const { resolve } = resolverRig('linux', ['/usr/bin/powershell', '/usr/bin/taskkill'], { PATH: '/usr/bin' });
    expect(await resolve('powershell')).toBeNull();
    expect(await resolve('taskkill')).toBeNull();
    expect(await resolve('icacls')).toBeNull();
  });

  it('resolves the opener: xdg-open on PATH for Linux, /usr/bin/open for macOS', async () => {
    expect(await resolverRig('linux', ['/usr/bin/xdg-open'], { PATH: '/usr/bin' }).resolve('opener')).toBe(
      '/usr/bin/xdg-open',
    );
    expect(await resolverRig('linux', [], { PATH: '/usr/bin' }).resolve('opener')).toBeNull();
    expect(await resolverRig('darwin', ['/usr/bin/open'], { PATH: '/usr/bin' }).resolve('opener')).toBe(
      '/usr/bin/open',
    );
    expect(await resolverRig('darwin', [], { PATH: '/usr/bin' }).resolve('opener')).toBeNull();
  });
});

describe('resolveExecutable on this machine', () => {
  it('node is process.execPath', async () => {
    expect(await resolveExecutable('node')).toBe(process.execPath);
  });

  it('resolves the Windows system programs to existing absolute .exe paths, and nothing on other systems', async () => {
    for (const name of ['powershell', 'taskkill', 'icacls', 'opener'] as const) {
      const found = await resolveExecutable(name);
      if (isWin) {
        expect(found).not.toBeNull();
        expect(path.isAbsolute(found ?? '')).toBe(true);
        expect((found ?? '').toLowerCase().endsWith('.exe')).toBe(true);
        expect(existsSync(found ?? '')).toBe(true);
      } else if (name !== 'opener') {
        expect(found).toBeNull();
      }
    }
    if (isWin) {
      expect(await resolveExecutable('powershell')).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
      expect(await resolveExecutable('ps')).toBeNull();
    }
  });

  it.runIf(gitInstalled)(
    'git is an absolute path, and never the cmd shim when the real git.exe sits next to it',
    async () => {
      const git = await resolveExecutable('git');
      expect(git).not.toBeNull();
      expect(path.isAbsolute(git ?? '')).toBe(true);
      const sibling = (git ?? '').replace(/\\cmd\\git\.exe$/i, '\\mingw64\\bin\\git.exe');
      if (isWin && sibling !== git) expect(existsSync(sibling)).toBe(false);
    },
  );
});

describe('spawnDetached and spawnForeground', () => {
  const baseEnv = (): Record<string, string> => {
    const env: Record<string, string> = { SAMPLE_VALUE: 'probe-value' };
    for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  };

  it('spawnDetached starts the program with the given cwd and env and sends stdio to the descriptors', async () => {
    const dir = makeTemp('exec').path;
    const out = path.join(dir, 'out.log');
    const err = path.join(dir, 'err.log');
    const outFd = openSync(out, 'a');
    const errFd = openSync(err, 'a');
    try {
      const child = spawnDetached(
        NODE,
        ['-e', 'console.log("hello " + process.env.SAMPLE_VALUE + " " + process.cwd()); console.error("oops")'],
        { cwd: dir, env: baseEnv(), stdoutFd: outFd, stderrFd: errFd },
      );
      expect(typeof child.pid).toBe('number');
      await once(child, 'exit');
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    expect(readFileSync(out, 'utf8')).toContain('hello probe-value');
    expect(readFileSync(err, 'utf8')).toContain('oops');
  });

  it('spawnDetached refuses a relative file or a .cmd on Windows before spawning anything', () => {
    const dir = makeTemp('exec').path;
    const options = { cwd: dir, env: baseEnv(), stdoutFd: 1, stderrFd: 2 };
    expect(() => spawnDetached('node', [], options)).toThrow(TypeError);
    if (isWin) expect(() => spawnDetached(path.join(dir, 'x.cmd'), [], options)).toThrow(TypeError);
  });

  it('a missing program is not a throw: no pid and an error event that the caller has to handle', async () => {
    const dir = makeTemp('exec').path;
    const missing = path.join(dir, 'no-such-program.exe');
    // Node reports ENOENT on the next tick: the handler has to be attached in the same tick as the spawn call, for each child.
    const attempts = [
      spawnDetached(missing, [], { cwd: dir, env: baseEnv(), stdoutFd: 1, stderrFd: 2 }),
      spawnForeground(missing, [], { cwd: dir, env: baseEnv() }),
    ].map((child) => ({
      pid: child.pid,
      failure: new Promise<Error>((resolve) => child.once('error', resolve)),
    }));
    for (const attempt of attempts) {
      expect(attempt.pid).toBeUndefined();
      expect(await attempt.failure).toMatchObject({ code: 'ENOENT' });
    }
  });

  it('spawnDetachedVisible starts the program detached with the given environment and no stdio (the browser window of the login)', async () => {
    const dir = makeTemp('exec').path;
    const out = path.join(dir, 'visible.txt');
    const child = spawnDetachedVisible(
      NODE,
      ['-e', 'require("node:fs").writeFileSync(process.env.SAMPLE_OUT, "hello " + process.env.SAMPLE_VALUE)'],
      { env: { ...baseEnv(), SAMPLE_OUT: out } },
    );
    expect(typeof child.pid).toBe('number');
    expect(child.stdin).toBeNull();
    expect(child.stdout).toBeNull();
    expect(child.stderr).toBeNull();
    await once(child, 'exit');
    expect(readFileSync(out, 'utf8')).toBe('hello probe-value');
  });

  it('spawnDetachedVisible refuses a relative file, a .cmd and a NUL character before spawning anything', () => {
    expect(() => spawnDetachedVisible('node', [], { env: baseEnv() })).toThrow(TypeError);
    expect(() => spawnDetachedVisible('', [], { env: baseEnv() })).toThrow(TypeError);
    expect(() => spawnDetachedVisible(`${NODE}\u0000`, [], { env: baseEnv() })).toThrow(TypeError);
    if (isWin) {
      expect(() => spawnDetachedVisible(path.join(makeTemp('exec').path, 'x.cmd'), [], { env: baseEnv() })).toThrow(
        TypeError,
      );
    }
  });

  it('spawnDetachedVisible on a missing program is no throw: no pid and an error event', async () => {
    const dir = makeTemp('exec').path;
    const child = spawnDetachedVisible(path.join(dir, 'no-such-program.exe'), [], { env: baseEnv() });
    const failure = new Promise<Error>((resolve) => child.once('error', resolve));
    expect(child.pid).toBeUndefined();
    expect(await failure).toMatchObject({ code: 'ENOENT' });
  });

  it('spawnDetachedVisible does not use the statistics of execFileText', async () => {
    const before = childStats();
    const dir = makeTemp('exec').path;
    const child = spawnDetachedVisible(NODE, ['-e', '0'], { env: baseEnv(), cwd: dir });
    await once(child, 'exit');
    expect(childStats()).toEqual(before);
  });

  it('spawnForeground runs with inherited stdio and reports the exit code', async () => {
    const dir = makeTemp('exec').path;
    const child = spawnForeground(NODE, ['-e', 'process.exit(7)'], { cwd: dir, env: baseEnv() });
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code).toBe(7);
    expect(() => spawnForeground('node', [], { cwd: dir, env: baseEnv() })).toThrow(TypeError);
  });
});

describe('T-LC-16: only exec.ts imports node:child_process, and every spawn passes windowsHide: true (but the one of the app window)', () => {
  const packagesDir = fileURLToPath(new URL('../../../', import.meta.url));
  const CHILD_MODULES = new Set(['node:child_process', 'child_process']);
  const SPAWN_LIKE = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']);
  const SHELL_LIKE = new Set(['exec', 'execSync']);

  function sources(): { file: string; rel: string; sf: ts.SourceFile }[] {
    const found: { file: string; rel: string; sf: ts.SourceFile }[] = [];
    for (const pkg of ['engine', 'server', 'cli', 'shared']) {
      const srcDir = path.join(packagesDir, pkg, 'src');
      let entries: string[];
      try {
        entries = readdirSync(srcDir, { recursive: true, encoding: 'utf8' });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.(ts|tsx)$/.test(entry) || entry.endsWith('.d.ts')) continue;
        const file = path.join(srcDir, entry);
        const text = readFileSync(file, 'utf8');
        found.push({
          file,
          rel: `${pkg}/src/${entry.split(path.sep).join('/')}`,
          sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true),
        });
      }
    }
    return found;
  }

  /** Module specifiers of imports, re-exports, require() and import() calls. */
  function moduleSpecifiers(sf: ts.SourceFile): string[] {
    const specs: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        if (ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        const [arg] = node.arguments;
        const callee = node.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        if (
          (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) &&
          arg !== undefined &&
          ts.isStringLiteralLike(arg)
        ) {
          specs.push(arg.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return specs;
  }

  it('finds source files to scan (the scan is not vacuous)', () => {
    const all = sources();
    expect(all.some((entry) => entry.rel === 'engine/src/platform/exec.ts')).toBe(true);
    expect(all.length).toBeGreaterThan(20);
  });

  it('allows the import of node:child_process in engine/src/platform/exec.ts only', () => {
    const offenders = sources()
      .filter((entry) => moduleSpecifiers(entry.sf).some((spec) => CHILD_MODULES.has(spec)))
      .map((entry) => entry.rel);
    expect(offenders).toEqual(['engine/src/platform/exec.ts']);
  });

  it('exec.ts never calls exec or execSync, never sets shell: true, and every spawn passes windowsHide: true except the app window of spawnDetachedVisible', () => {
    const entry = sources().find((candidate) => candidate.rel === 'engine/src/platform/exec.ts');
    expect(entry).toBeDefined();
    const spawnCalls: ts.CallExpression[] = [];
    const shellCalls: string[] = [];
    const shellTrue: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (SPAWN_LIKE.has(node.expression.text)) spawnCalls.push(node);
        if (SHELL_LIKE.has(node.expression.text)) shellCalls.push(node.expression.text);
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'shell' &&
        node.initializer.kind === ts.SyntaxKind.TrueKeyword
      ) {
        shellTrue.push('shell: true');
      }
      ts.forEachChild(node, visit);
    };
    if (entry !== undefined) visit(entry.sf);
    expect(shellCalls).toEqual([]);
    expect(shellTrue).toEqual([]);
    expect(spawnCalls.length).toBeGreaterThanOrEqual(4);
    /** The function that holds a call: the one place that may show a window is `spawnDetachedVisible` (06 2.5). */
    const enclosingFunction = (node: ts.Node): string | null => {
      let current: ts.Node = node;
      while (!ts.isSourceFile(current)) {
        current = current.parent;
        if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
      }
      return null;
    };
    const visible: string[] = [];
    for (const call of spawnCalls) {
      const options = call.arguments[call.arguments.length - 1];
      expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
      const hide =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === 'windowsHide',
            )
          : undefined;
      if (enclosingFunction(call) === 'spawnDetachedVisible') {
        visible.push('spawnDetachedVisible');
        expect(hide?.initializer.kind).toBe(ts.SyntaxKind.FalseKeyword);
      } else {
        expect(hide?.initializer.kind).toBe(ts.SyntaxKind.TrueKeyword);
      }
    }
    // exactly one call shows a window, the one of the browser app window; every other spawn stays hidden
    expect(visible).toEqual(['spawnDetachedVisible']);
  });
});
