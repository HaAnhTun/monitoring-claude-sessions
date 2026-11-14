// The fake claude of the testkit (design 08, section 2). A small interactive program that stands in for the real `claude` in every
// terminal test: it prints a banner, answers the commands below, can write the transcript and the registry entry a real client
// writes, and logs what it received. One self-contained ES module: Node built-ins only, no import from the repository, so it runs
// from `src` and from `dist` of the testkit and a person can run it (`node fake-claude.mjs --install <dir>` puts launchers into
// <dir> and prints the PATH line). `src/fake-claude/protocol.ts` holds the same constants for the tests; a test fails when the two
// drift apart.
//
// Input: a line ends at CR, LF or CRLF. With a terminal on stdin the fake sets raw mode and echoes what is typed, handles Backspace,
// Tab, Ctrl+C and Ctrl+D; without one (pipe mode) it reads the same bytes and echoes nothing. Every answer starts with a tag at the
// beginning of a line and every line ends with CRLF. Nothing depends on time or randomness unless a command asks for it.
//
// Commands: /size /colors /burst|/big /utf8 /exit /exit-now /last-words /crash /throw /echo /query /rewrite-id /pid /cwd /args /env
// /envnames /envscan /ignore-signals /spawn-child|/spawn /transcript /status /hostile; a bracketed paste; any other text is echoed.
// Environment: FAKE_CLAUDE_LOG (a JSON line per event), FAKE_CLAUDE_STARTUP (exit:<code> or hang), FAKE_CLAUDE_AUTOREGISTER=1,
// FAKE_CLAUDE_KEEP_REGISTRY=1, FAKE_CLAUDE_SEED. The transcript and the registry go below CLAUDE_CONFIG_DIR, which must be an
// absolute path: the fake never falls back to a real home.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const ESC = '\x1b';
const BEL = '\x07';
const PASTE_END = `${ESC}[201~`;
const BANNER = 'Claude Code (fake) 0.0.0-test';
const PROMPT = '> ';
const DEFAULT_SEED = 'fake-claude';
const SAFE_ENV_NAMES = [
  'COLORTERM',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CLAUDECODE',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
];
const ENVSCAN_MIN_NEEDLE = 8;
const BURST_MAX_KIB = 8192;
const BURST_DEFAULT_LINE_BYTES = 100;
const BURST_MIN_LINE_BYTES = 12;
const BURST_FILL = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HOSTILE_LONG_LINE_BYTES = 1024 * 1024;
const CRASH_CODE = 3;
const FILE_NAME = 'fake-claude.mjs';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const TAG = {
  ready: 'READY',
  echo: 'ECHO:',
  size: 'SIZE:',
  resize: 'RESIZE:',
  pid: 'PID:',
  cwd: 'CWD:',
  args: 'ARGS:',
  env: 'ENV:',
  envNames: 'ENVNAMES:',
  envScan: 'ENVSCAN:',
  colorsDone: 'COLORS-DONE',
  burstDone: 'BURST-DONE:',
  utf8Done: 'UTF8-DONE:',
  bye: 'BYE:',
  crash: 'CRASH',
  child: 'CHILD:',
  paste: 'PASTE:',
  interrupt: 'INTERRUPT',
  tab: 'TAB',
  signal: 'SIGNAL:',
  ignoring: 'IGNORING',
  lastWords: 'LAST-WORDS:',
  hostileDone: 'HOSTILE-DONE',
  transcript: 'TRANSCRIPT:',
  status: 'STATUS:',
  rewrote: 'REWROTE:',
  query: 'QUERY:',
  unknown: 'UNKNOWN:',
  error: 'ERROR:',
};

const argv = process.argv.slice(2);

// ---- launchers (the same text as `fakeClaudeLauncher` in install.ts; a test compares the two) -----------------------------------

function isAscii(text) {
  for (const char of text) if (char.codePointAt(0) > 0x7f) return false;
  return true;
}

function launcher(kind, nodePath) {
  if (kind === 'cmd') {
    const node = isAscii(nodePath) && !nodePath.includes('"') ? `"${nodePath}"` : 'node';
    return `@ECHO off\r\n${node} "%~dp0${FILE_NAME}" %*\r\n`;
  }
  if (kind === 'ps1') {
    return `#!/usr/bin/env pwsh\r\n& '${nodePath.replaceAll("'", "''")}' (Join-Path $PSScriptRoot '${FILE_NAME}') @args\r\nexit $LASTEXITCODE\r\n`;
  }
  return `#!/bin/sh\nexec "${nodePath.replaceAll('\\', '/')}" "$(dirname "$0")/${FILE_NAME}" "$@"\n`;
}

function installMain(args) {
  const usage = () => {
    process.stderr.write(`usage: node ${FILE_NAME} --install <dir> [--flavour npm-shim|cmd-only|sh]\n`);
    process.exit(2);
  };
  const dir = args[0];
  if (dir === undefined || dir === '' || dir.startsWith('--')) usage();
  const at = args.indexOf('--flavour');
  const flavour = at >= 0 ? args[at + 1] : process.platform === 'win32' ? 'npm-shim' : 'sh';
  if (!['npm-shim', 'cmd-only', 'sh'].includes(flavour)) usage();
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  const script = join(target, FILE_NAME);
  if (resolve(self) !== script) copyFileSync(self, script);
  if (flavour !== 'sh') writeFileSync(join(target, 'claude.cmd'), launcher('cmd', process.execPath));
  if (flavour === 'npm-shim') writeFileSync(join(target, 'claude.ps1'), launcher('ps1', process.execPath));
  if (flavour !== 'cmd-only') {
    const sh = join(target, 'claude');
    writeFileSync(sh, launcher('sh', process.execPath));
    chmodSync(sh, 0o755);
  }
  const line =
    process.platform === 'win32'
      ? `set "PATH=${target}${delimiter}%PATH%"`
      : `export PATH="${target}${delimiter}$PATH"`;
  process.stdout.write(`${line}\n`);
}

// ---- the program ---------------------------------------------------------------------------------------------------------------

function detUuid(seed, n) {
  const hex = createHash('sha256')
    .update(`${seed}|${String(n)}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex.charAt(15), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(12, 15)}-${variant}${hex.slice(16, 19)}-${hex.slice(19, 31)}`;
}

function fnv(hash, text) {
  let next = hash;
  for (let i = 0; i < text.length; i += 1) {
    next ^= text.charCodeAt(i);
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  return next;
}

function burstLine(seq, lineBytes) {
  let fill = '';
  for (let i = 0; i < lineBytes - 10; i += 1) fill += BURST_FILL.charAt((seq + i) % BURST_FILL.length);
  return `B${String(seq).padStart(6, '0')}:${fill}\r\n`;
}

function printable(value) {
  return [...value].filter((char) => char.codePointAt(0) >= 0x20 && char.codePointAt(0) !== 0x7f).join('');
}

function intArg(text, fallback, min, max) {
  const parsed = Number.parseInt(text ?? '', 10);
  return Math.min(Math.max(Number.isNaN(parsed) ? fallback : parsed, min), max);
}

function resumeId() {
  if (argv.includes('--fork-session')) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = arg === '--resume' || arg === '-r' ? argv[i + 1] : arg.startsWith('--resume=') ? arg.slice(9) : null;
    if (typeof value === 'string' && SESSION_ID_RE.test(value)) return value;
  }
  return null;
}

function main() {
  const seed = process.env.FAKE_CLAUDE_SEED || DEFAULT_SEED;
  const state = {
    sessionId: resumeId() ?? detUuid(seed, 'session-0'),
    status: 'idle',
    waitingFor: undefined,
    cwd: process.cwd(),
    startedAt: Date.now(),
    registered: false,
    transcriptFor: null,
    recSeq: 0,
    turns: 0,
    lastUuid: null,
    lastTimestamp: 0,
    handled: 0,
    exiting: false,
  };

  // The log: one JSON line per event, a counter and no timestamps. Best effort: a test that cannot write it still runs.
  let logCounter = 0;
  const log = (ev, fields = {}) => {
    const file = process.env.FAKE_CLAUDE_LOG;
    if (file === undefined || file === '') return;
    logCounter += 1;
    try {
      appendFileSync(file, `${JSON.stringify({ n: logCounter, ev, ...fields })}\n`);
    } catch {
      // the log is best effort
    }
  };

  const claudeHome = () => {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    return typeof dir === 'string' && dir !== '' && isAbsolute(dir) ? dir : null;
  };
  const registryPath = (home) => join(home, 'sessions', `${String(process.pid)}.json`);

  process.on('exit', (code) => {
    log('exit', { code });
    const home = claudeHome();
    if (state.registered && home !== null && process.env.FAKE_CLAUDE_KEEP_REGISTRY !== '1') {
      try {
        rmSync(registryPath(home), { force: true });
      } catch {
        // already gone
      }
    }
  });

  log('start', { argv, env: Object.keys(process.env).sort() });
  const startup = process.env.FAKE_CLAUDE_STARTUP ?? '';
  const exitAt = /^exit:(\d{1,3})$/.exec(startup);
  if (exitAt !== null) process.exit(Number(exitAt[1]));
  if (startup === 'hang') {
    // Nothing is printed and nothing ends it, not even the end of input. Input is read and dropped so that a writer never blocks.
    process.stdin.on('data', () => undefined);
    process.stdin.on('error', () => undefined);
    setInterval(() => undefined, 60_000);
    return;
  }

  // ---- output ----
  process.stdout.on('error', () => undefined);
  const out = (text) => {
    process.stdout.write(text);
  };
  const line = (text) => {
    out(`${text}\r\n`);
  };
  const flush = (chunk) =>
    new Promise((done) => {
      process.stdout.write(chunk, () => {
        done();
      });
    });
  /** Drains what was written, then exits; nothing queued after this runs. */
  const finish = (code) => {
    state.exiting = true;
    process.stdout.write('', () => {
      process.exit(code);
    });
  };

  // ---- registry and transcript (section 2.5) ----
  const writeRegistry = () => {
    const home = claudeHome();
    if (home === null) return false;
    const entry = {
      pid: process.pid,
      sessionId: state.sessionId,
      status: state.status,
      cwd: state.cwd,
      startedAt: state.startedAt,
      kind: 'interactive',
      ...(state.waitingFor === undefined ? {} : { waitingFor: state.waitingFor }),
    };
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(registryPath(home), `${JSON.stringify(entry, null, 2)}\n`);
    state.registered = true;
    return true;
  };

  const timestamp = () => {
    state.lastTimestamp = Math.max(Date.now(), state.lastTimestamp + 1);
    return new Date(state.lastTimestamp).toISOString();
  };
  const record = (type, extra) => {
    const uuid = detUuid(state.sessionId, state.recSeq);
    state.recSeq += 1;
    const body = {
      type,
      uuid,
      parentUuid: state.lastUuid,
      isSidechain: false,
      sessionId: state.sessionId,
      cwd: state.cwd,
      timestamp: timestamp(),
      entrypoint: 'cli',
      version: '0.0.0-test',
      ...extra,
    };
    state.lastUuid = uuid;
    return `${JSON.stringify(body)}\n`;
  };
  const transcriptFile = (home) =>
    join(home, 'projects', state.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${state.sessionId}.jsonl`);

  /** Appends `count` turns (a prompt and an answer that ends the turn) to the transcript of the current session id. */
  const writeTurns = (home, count) => {
    const file = transcriptFile(home);
    mkdirSync(dirname(file), { recursive: true });
    if (state.transcriptFor !== state.sessionId) {
      // The first write for this id continues after the records already in the file (a resumed session).
      state.recSeq = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
      state.turns = Math.floor(state.recSeq / 2);
      state.lastUuid = null;
      state.transcriptFor = state.sessionId;
    }
    const tag = detUuid(state.sessionId, 'tag').slice(0, 8);
    let text = '';
    for (let i = 0; i < count; i += 1) {
      const turn = state.turns;
      state.turns += 1;
      const number = String(turn).padStart(3, '0');
      text += record('user', {
        promptId: detUuid(state.sessionId, `prompt-${String(turn)}`),
        message: { role: 'user', content: `FIXTURE prompt ${String(turn)}` },
      });
      text += record('assistant', {
        requestId: `req_fake_${tag}_${number}`,
        message: {
          id: `msg_fake_${tag}_${number}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: `FIXTURE assistant reply ${String(turn)}` }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            service_tier: 'standard',
          },
          container: null,
          context_management: null,
          diagnostics: null,
        },
      });
    }
    appendFileSync(file, text);
  };

  // ---- commands ----
  const noHome = () => {
    line(`${TAG.error}no-config-dir`);
  };

  const commands = {
    '/size': () => {
      const { columns, rows } = process.stdout;
      line(
        columns === undefined || rows === undefined
          ? `${TAG.size}unknown`
          : `${TAG.size}${String(columns)}x${String(rows)}`,
      );
    },

    '/colors': () => {
      const hex = (n) => n.toString(16);
      let foreground = 'FG16 ';
      let background = 'BG16 ';
      for (let i = 0; i < 16; i += 1) {
        foreground += `${ESC}[${String(i < 8 ? 30 + i : 82 + i)}m${hex(i)}${ESC}[0m`;
        background += `${ESC}[${String(i < 8 ? 40 + i : 92 + i)}m ${ESC}[0m`;
      }
      line(foreground);
      line(background);
      for (let row = 0; row < 8; row += 1) {
        let ramp = `R256 ${String(row)} `;
        for (let i = row * 32; i < row * 32 + 32; i += 1) ramp += `${ESC}[38;5;${String(i)}m#${ESC}[0m`;
        line(ramp);
      }
      let gradient = 'TRUE ';
      for (let i = 0; i < 64; i += 1) gradient += `${ESC}[38;2;${String(i * 4)};${String(255 - i * 4)};128m#${ESC}[0m`;
      line(gradient);
      line(TAG.colorsDone);
    },

    '/burst': async (arg) => {
      const [kibText, bytesText] = arg.split(/\s+/);
      const kib = intArg(kibText, 1, 1, BURST_MAX_KIB);
      const width = Math.max(BURST_MIN_LINE_BYTES, intArg(bytesText, BURST_DEFAULT_LINE_BYTES, 0, 1 << 20));
      const lines = Math.max(1, Math.floor((kib * 1024) / width));
      let hash = 0x811c9dc5;
      let chunk = '';
      for (let seq = 0; seq < lines; seq += 1) {
        chunk += burstLine(seq, width);
        if (chunk.length >= 32768) {
          hash = fnv(hash, chunk);
          await flush(chunk);
          chunk = '';
        }
      }
      if (chunk !== '') {
        hash = fnv(hash, chunk);
        await flush(chunk);
      }
      line(`${TAG.burstDone}${String(lines)}:${(hash >>> 0).toString(16).padStart(8, '0')}`);
    },

    '/utf8': async (arg) => {
      const count = intArg(arg, 1, 1, 1000);
      const unit = Buffer.from(String.fromCodePoint(0xe9, 0x6f22, 0x20000));
      for (let i = 0; i < count; i += 1) {
        for (const byte of unit) await flush(Buffer.from([byte]));
      }
      out('\r\n');
      line(`${TAG.utf8Done}${String(count)}`);
    },

    '/exit': (arg) => {
      const code = intArg(arg, 0, 0, 255);
      line(`${TAG.bye}${String(code)}`);
      finish(code);
    },

    '/exit-now': (arg) => {
      process.exit(intArg(arg, 0, 0, 255));
    },

    '/last-words': () => {
      out(`${TAG.lastWords}${String(state.handled)}\r\n`);
      process.exit(0);
    },

    '/crash': (arg) => {
      line(TAG.crash);
      finish(intArg(arg, CRASH_CODE, 0, 255));
    },

    '/throw': () => {
      setImmediate(() => {
        throw new Error('fake-claude: uncaught error requested by /throw');
      });
    },

    '/query': () => {
      line(`${TAG.query}${ESC}[c${ESC}[6n`);
    },

    '/rewrite-id': (arg) => {
      if (!UUID_RE.test(arg)) {
        line(`${TAG.error}session-id`);
        return;
      }
      const home = claudeHome();
      const continued = state.transcriptFor !== null;
      state.sessionId = arg;
      if (home !== null) {
        if (continued) writeTurns(home, 1);
        if (state.registered) writeRegistry();
      }
      line(`${TAG.rewrote}${arg}`);
    },

    '/pid': () => {
      line(`${TAG.pid}${String(process.pid)} PPID:${String(process.ppid)}`);
    },

    '/cwd': () => {
      line(`${TAG.cwd}${process.cwd()}`);
    },

    '/args': () => {
      line(`${TAG.args}${JSON.stringify(argv)}`);
    },

    '/env': (arg) => {
      for (const name of arg === '' ? [] : arg.split(/\s+/)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
          line(`${TAG.env}INVALID`);
          continue;
        }
        const value = process.env[name];
        if (SAFE_ENV_NAMES.includes(name))
          line(`${TAG.env}${name}=${value === undefined ? 'UNSET' : printable(value)}`);
        else line(`${TAG.env}${name}=${value === undefined ? 'UNSET' : 'set'}`);
      }
    },

    '/envnames': (arg) => {
      const prefix = arg.split(/\s+/)[0];
      const fold = (text) => (process.platform === 'win32' ? text.toUpperCase() : text);
      const names = Object.keys(process.env)
        .filter((name) => fold(name).startsWith(fold(prefix)))
        .sort();
      line(`${TAG.envNames}${prefix}:${names.join(',')}`);
    },

    '/envscan': (arg) => {
      const needle = arg.split(/\s+/)[0];
      if (needle.length < ENVSCAN_MIN_NEEDLE) {
        line(`${TAG.envScan}TOO-SHORT`);
        return;
      }
      const haystack = [...Object.values(process.env), ...process.argv];
      line(
        `${TAG.envScan}${haystack.some((value) => value !== undefined && value.includes(needle)) ? 'FOUND' : 'ABSENT'}`,
      );
    },

    '/ignore-signals': () => {
      for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        process.on(name, () => {
          log('signal', { name });
          line(`${TAG.signal}${name}`);
        });
      }
      line(TAG.ignoring);
    },

    '/spawn-child': () => {
      // Not detached, as the children of a real client are: a tree kill has a descendant to find. (On Windows libuv puts it in a job
      // that ends with this process; elsewhere it outlives the process. Either way this process neither waits for it nor ends it.)
      const child = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 600000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
      line(child.pid === undefined ? `${TAG.error}spawn` : `${TAG.child}${String(child.pid)}`);
    },

    '/transcript': (arg) => {
      const home = claudeHome();
      if (home === null) {
        noHome();
        return;
      }
      const match = /^(\d+)(?:\s+(.*))?$/.exec(arg);
      if (arg !== '' && match === null) {
        line(`${TAG.error}turns`);
        return;
      }
      const turns = match === null ? 1 : Math.min(Math.max(Number(match[1]), 1), 100);
      if (match?.[2] !== undefined && match[2] !== '') state.cwd = match[2];
      writeTurns(home, turns);
      writeRegistry();
      line(`${TAG.transcript}${state.sessionId}`);
    },

    '/status': (arg) => {
      const word = arg.split(/\s+/)[0];
      if (!['busy', 'idle', 'waiting'].includes(word)) {
        line(`${TAG.error}status`);
        return;
      }
      if (claudeHome() === null) {
        noHome();
        return;
      }
      const text = arg.slice(word.length).trim();
      state.status = word;
      state.waitingFor = word === 'waiting' && text !== '' ? text : undefined;
      writeRegistry();
      line(`${TAG.status}${word}`);
    },

    '/hostile': async () => {
      const link = (target, label) => `${ESC}]8;;${target}${ESC}\\${label}${ESC}]8;;${ESC}\\`;
      out(`${ESC}]52;c;${Buffer.from('FIXTURE-HOSTILE-CLIPBOARD').toString('base64')}${BEL}`);
      out(`${ESC}]0;FIXTURE hostile title${BEL}`);
      out(link('javascript:alert(1)', 'script link'));
      out(link('http://example.invalid/', 'web link'));
      out(`${ESC}[21t${ESC}[6n`);
      out(BEL.repeat(1000));
      await flush(Buffer.alloc(HOSTILE_LONG_LINE_BYTES, 'x'));
      await flush(Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xf0, 0x28, 0x8c, 0xbc]));
      out('\r\n');
      line(TAG.hostileDone);
    },
  };
  commands['/big'] = commands['/burst'];
  commands['/spawn'] = commands['/spawn-child'];

  const handleLine = async (text) => {
    state.handled += 1;
    const body = text.trimStart();
    if (body !== '') {
      const space = body.search(/\s/);
      const name = body.startsWith('/') ? (space < 0 ? body : body.slice(0, space)) : null;
      const rest = space < 0 ? '' : body.slice(space + 1);
      const words = (value) => (value.trim() === '' ? 0 : value.trim().split(/\s+/).length);
      if (name === null) {
        log('cmd', { name: 'text', args: words(text) });
        line(`${TAG.echo}${text}`);
      } else if (name === '/echo') {
        log('cmd', { name, args: words(rest) });
        line(rest);
      } else if (Object.hasOwn(commands, name)) {
        log('cmd', { name, args: words(rest) });
        await commands[name](rest.trim());
      } else {
        log('cmd', { name, args: words(rest) });
        line(`${TAG.unknown}${printable(name.slice(1)).slice(0, 64)}`);
      }
    }
    if (!state.exiting) out(PROMPT);
  };

  const handlePaste = (text) => {
    log('cmd', { name: 'paste', args: 0 });
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
    line(`${TAG.paste}${String([...text].length)}:${hash}`);
    out(PROMPT);
  };

  // ---- input ----
  let chain = Promise.resolve();
  const enqueue = (task) => {
    chain = chain.then(async () => {
      if (state.exiting) return;
      try {
        await task();
      } catch (error) {
        process.stderr.write(
          `fake-claude: internal error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
  };

  const echoing = process.stdin.isTTY === true;
  let mode = 'text';
  let buffer = '';
  let csi = '';
  let paste = '';
  let afterCr = false;

  const endLine = () => {
    const text = buffer;
    buffer = '';
    enqueue(() => {
      out('\r\n');
      return handleLine(text);
    });
  };
  const interrupt = () => {
    buffer = '';
    enqueue(() => {
      out('^C\r\n');
      line(TAG.interrupt);
      out(PROMPT);
    });
  };
  const tab = () => {
    const typed = buffer;
    enqueue(() => {
      out('\r\n');
      line(TAG.tab);
      out(echoing ? `${PROMPT}${typed}` : PROMPT);
    });
  };
  const textChar = (char) => {
    const skip = afterCr && char === '\n';
    afterCr = false;
    if (skip) return;
    switch (char) {
      case ESC:
        mode = 'esc';
        break;
      case '\r':
        afterCr = true;
        endLine();
        break;
      case '\n':
        endLine();
        break;
      case '\x03':
        interrupt();
        break;
      case '\x04':
        if (buffer === '') enqueue(() => finish(0));
        break;
      case '\x7f':
      case '\b':
        if (buffer !== '') {
          buffer = [...buffer].slice(0, -1).join('');
          if (echoing) out('\b \b');
        }
        break;
      case '\t':
        tab();
        break;
      default:
        if (char >= ' ') {
          buffer += char;
          if (echoing) out(char);
        }
    }
  };
  const feed = (text) => {
    for (const char of text) {
      if (mode === 'paste') {
        paste += char;
        if (paste.endsWith(PASTE_END)) {
          const pasted = paste.slice(0, -PASTE_END.length);
          mode = 'text';
          paste = '';
          enqueue(() => {
            out('\r\n');
            handlePaste(pasted);
          });
        }
      } else if (mode === 'esc') {
        mode = char === '[' ? 'csi' : char === 'O' ? 'ss3' : 'text';
        csi = '';
      } else if (mode === 'ss3') {
        mode = 'text';
      } else if (mode === 'csi') {
        const code = char.codePointAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          mode = csi + char === '200~' ? 'paste' : 'text';
          paste = '';
        } else if (code >= 0x20 && code <= 0x3f) {
          csi += char;
        } else {
          mode = 'text';
        }
      } else {
        textChar(char);
      }
    }
  };

  // ---- start ----
  if (process.env.FAKE_CLAUDE_AUTOREGISTER === '1') writeRegistry();
  const { columns, rows } = process.stdout;
  out(`${ESC}[?2004h${BANNER}\r\n`);
  line(
    `${TAG.ready} pid=${String(process.pid)} cols=${columns === undefined ? 'unknown' : String(columns)} rows=${rows === undefined ? 'unknown' : String(rows)} args=${JSON.stringify(argv)}`,
  );
  out(PROMPT);

  process.stdout.on('resize', () => {
    const { columns: cols, rows: lines } = process.stdout;
    log('resize', { cols, rows: lines });
    line(`${TAG.resize}${String(cols)}x${String(lines)}`);
  });
  if (process.stdin.isTTY === true) process.stdin.setRawMode(true);
  const decoder = new StringDecoder('utf8');
  process.stdin.on('error', () => undefined);
  process.stdin.on('data', (chunk) => {
    log('stdin', { hex: chunk.toString('hex') });
    feed(decoder.write(chunk));
  });
  process.stdin.on('end', () => {
    feed(decoder.end());
    if (buffer !== '') endLine();
    enqueue(() => finish(0));
  });
}

if (argv[0] === '--install') installMain(argv.slice(1));
else main();
