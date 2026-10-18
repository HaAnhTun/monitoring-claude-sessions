// Fake `docker` for the harness tests: records each argument list (one JSON line in FAKE_DOCKER_LOG), saves stdin to
// FAKE_DOCKER_DIR/<n>.stdin and plays the scripted answer of FAKE_DOCKER_PLAN:
// { version, inspect, build: exit codes; ps, images: stdout; run: { "<name substring>": { code, out, hang } } }.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const plan = JSON.parse(process.env.FAKE_DOCKER_PLAN ?? '{}');
const logFile = process.env.FAKE_DOCKER_LOG;
const seq = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length;
appendFileSync(logFile, `${JSON.stringify(args)}\n`);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  writeFileSync(join(process.env.FAKE_DOCKER_DIR, `${seq}.stdin`), data);
  return data;
}

const [command] = args;
if (command === 'version') process.exit(plan.version ?? 0);
if (command === 'image') process.exit(plan.inspect ?? 1);
if (command === 'ps') {
  process.stdout.write(plan.ps ?? '');
  process.exit(0);
}
if (command === 'images') {
  process.stdout.write(plan.images ?? '');
  process.exit(0);
}
if (command === 'rm' || command === 'rmi') process.exit(0);
if (command === 'build') {
  await readStdin();
  process.exit(plan.build ?? 0);
}
if (command === 'run') {
  await readStdin();
  const name = args[args.indexOf('--name') + 1] ?? '';
  const entry = Object.entries(plan.run ?? {}).find(([key]) => name.endsWith(key))?.[1] ?? {};
  process.stdout.write(entry.out ?? '| gate | result | ms |\n|---|---|---|\n| npm ci | PASS | 5 |\n');
  if (entry.hang) {
    appendFileSync(logFile, `${JSON.stringify(['#hanging', name])}\n`);
    setInterval(() => undefined, 1000); // stays up until the harness kills it
  } else process.exit(entry.code ?? 0);
} else process.exit(3);
