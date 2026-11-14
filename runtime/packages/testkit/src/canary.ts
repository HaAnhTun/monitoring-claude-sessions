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

function* filesUnder(path: string, who: string): Generator<string> {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new Error(`${who}: ${path} does not exist`);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* filesUnder(join(path, name), who);
  } else if (stat.isFile()) {
    yield path;
  }
}

interface Wanted {
  name: string;
  bytes: Buffer;
}

function scan(paths: readonly string[], wanted: readonly Wanted[], who: string): { file: string; name: string }[] {
  const hits: { file: string; name: string }[] = [];
  for (const root of paths) {
    for (const file of filesUnder(root, who)) {
      const content = readFileSync(file);
      for (const { name, bytes } of wanted) {
        if (content.includes(bytes)) hits.push({ file, name });
      }
    }
  }
  return hits;
}

/**
 * Reads every file under `paths` (folders are walked, links are not followed) as bytes and reports each needle found, in the
 * order of the files and then of the needles. A needle is text (UTF-8) or bytes; a hit of bytes names the needle in hex
 * (`0x0203`). A path that does not exist, an empty needle and an empty list of needles throw: a scan of nothing must not pass
 * silently. The terminal tests use it for the strings that must never reach a log, a file or the database.
 */
export function scanFilesFor(
  paths: readonly string[],
  needles: readonly (string | Uint8Array)[],
): { file: string; needle: string }[] {
  if (needles.length === 0) throw new RangeError('scanFilesFor: no needles: a scan for nothing proves nothing');
  const wanted = needles.map((needle): Wanted => {
    const bytes = typeof needle === 'string' ? Buffer.from(needle, 'utf8') : Buffer.from(needle);
    if (bytes.length === 0) throw new RangeError('scanFilesFor: a needle must not be empty');
    return { name: typeof needle === 'string' ? needle : `0x${bytes.toString('hex')}`, bytes };
  });
  return scan(paths, wanted, 'scanFilesFor').map(({ file, name }) => ({ file, needle: name }));
}

/**
 * Reads every file under `paths` (folders are walked, links are not followed) as bytes and reports each canary found that is
 * not in `allowed`. A path that does not exist throws: a scan of nothing must not pass silently.
 */
export function scanForCanaries(
  paths: readonly string[],
  allowed: readonly CanaryKind[],
): { file: string; canary: string }[] {
  const wanted = KINDS.filter((kind) => !allowed.includes(kind)).map((kind) => ({
    name: kind,
    bytes: Buffer.from(CANARY[kind]),
  }));
  return scan(paths, wanted, 'scanForCanaries').map(({ file, name }) => ({ file, canary: name }));
}
