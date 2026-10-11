// Canaries (05 4.10): strings planted in synthetic prompts, results, keys and queries. A test then scans logs, the database
// and API output and fails when a canary shows up where it must not (privacy by construction).
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANARY = {
  prompt: 'FIXTURE-CANARY-PROMPT-8f3a6c21',
  toolResult: 'FIXTURE-CANARY-TOOLRESULT-5b9e0d74',
  thinking: 'FIXTURE-CANARY-THINKING-c4172ae9',
  key: 'FIXTURE-CANARY-KEY-27d8f6b0',
  envToken: 'FIXTURE-CANARY-ENVTOKEN-9a05e3c1',
  attachment: 'FIXTURE-CANARY-ATTACHMENT-61bd7f48',
  query: 'FIXTURE-CANARY-QUERY-d02c8e95',
} as const satisfies Record<string, string>;

export type CanaryKind = keyof typeof CANARY;

const KINDS: readonly CanaryKind[] = ['prompt', 'toolResult', 'thinking', 'key', 'envToken', 'attachment', 'query'];

function* filesUnder(path: string): Generator<string> {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new Error(`scanForCanaries: ${path} does not exist`);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* filesUnder(join(path, name));
  } else if (stat.isFile()) {
    yield path;
  }
}

/**
 * Reads every file under `paths` (folders are walked, links are not followed) as bytes and reports each canary found that is
 * not in `allowed`. A path that does not exist throws: a scan of nothing must not pass silently.
 */
export function scanForCanaries(
  paths: readonly string[],
  allowed: readonly CanaryKind[],
): { file: string; canary: string }[] {
  const needles = KINDS.filter((kind) => !allowed.includes(kind)).map((kind) => ({
    kind,
    bytes: Buffer.from(CANARY[kind]),
  }));
  const hits: { file: string; canary: string }[] = [];
  for (const root of paths) {
    for (const file of filesUnder(root)) {
      const content = readFileSync(file);
      for (const { kind, bytes } of needles) {
        if (content.includes(bytes)) hits.push({ file, canary: kind });
      }
    }
  }
  return hits;
}
