// A recording git for tests/tooling/ci-status.test.ts: appends one JSON line per call to FAKE_GIT_LOG (the argument list, the
// prompt switch and whether an extra header came in through the environment; never the header value) and then runs the real
// git with the same arguments, stdin and environment.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
appendFileSync(
  process.env.FAKE_GIT_LOG ?? 'fake-git.log',
  `${JSON.stringify({
    argv,
    prompt: process.env.GIT_TERMINAL_PROMPT ?? null,
    askpass: process.env.GIT_ASKPASS ?? null,
    header: process.env.GIT_CONFIG_KEY_0 === 'http.extraheader' && (process.env.GIT_CONFIG_VALUE_0 ?? '') !== '',
  })}\n`,
);
let input;
try {
  input = readFileSync(0);
} catch {
  input = undefined;
}
const result = spawnSync('git', argv, { input, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
process.exit(result.status ?? 1);
