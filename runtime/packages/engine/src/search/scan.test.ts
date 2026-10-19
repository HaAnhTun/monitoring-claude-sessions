// The scanning half of the transcript content search (03 7.4, DA-T-S-3): the prefilter, the legacy match rules and the block
// scan, over real files in a temp folder. Every transcript is synthetic; characters outside ASCII are built from code points.
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EntryKind } from '@mcs/shared';
import { useTempDirs } from '@mcs/testkit';
import { describe, expect, it } from 'vitest';

import { displayEntries, type DisplayEntry } from '../transcript/entries.ts';
import {
  NO_RELATION,
  buildPrefilter,
  escapeRegExp,
  haystackOf,
  keeps,
  relationPatterns,
  scanBlock,
  scanRelation,
  snippetOf,
  type BlockOutcome,
  type Criteria,
  type Hit,
  type RelationSets,
  type ScanEnv,
} from './scan.ts';

const makeTemp = useTempDirs();
const BACKSLASH = String.fromCharCode(92);
const E_ACUTE = String.fromCodePoint(0xe9);
const SIGMA = String.fromCodePoint(0x3a3);
const CJK = String.fromCodePoint(0x4e2d, 0x6587);
const EMOJI = String.fromCodePoint(0x1f600);
const SHARP_S = String.fromCodePoint(0xdf);

/** The text with every UTF-16 unit above ASCII written as a backslash-u escape, as a writer that escapes would. */
function escapeUnits(text: string, upper = false): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      out += text.charAt(i);
      continue;
    }
    const hex = unit.toString(16).padStart(4, '0');
    out += `${BACKSLASH}u${upper ? hex.toUpperCase() : hex}`;
  }
  return out;
}

function criteria(over: Partial<Criteria> = {}): Criteria {
  return { needle: '', kinds: null, tool: null, errors: false, ...over };
}

const live = (): AbortSignal => new AbortController().signal;

function envOf(path: string, over: Partial<ScanEnv> = {}): ScanEnv {
  return { path, chunkBytes: 1024 * 1024, textChars: 6000, signal: live(), clock: () => performance.now(), ...over };
}

/** Writes the lines (LF-terminated) and returns the byte offset of each line. */
function writeFile(path: string, lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += Buffer.byteLength(line) + 1;
  }
  writeFileSync(path, lines.map((line) => `${line}\n`).join(''));
  return offsets;
}

const user = (text: string): Record<string, unknown> => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: { role: 'user', content: text },
});
const say = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolUse = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: 'assistant',
  timestamp: '2026-01-01T00:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, content: string, isError: boolean): Record<string, unknown> => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:03.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
});

function entry(over: Partial<DisplayEntry> & { k: EntryKind }): DisplayEntry {
  return { t: '', ...over };
}

describe('escapeRegExp', () => {
  it('makes every special character literal', () => {
    const special = `.*+?^\${}()|[]-/${BACKSLASH}`;
    expect(new RegExp(`^${escapeRegExp(special)}$`).test(special)).toBe(true);
    expect(new RegExp(escapeRegExp('a.c')).test('abc')).toBe(false);
  });
});

describe('buildPrefilter', () => {
  it('finds the needle in the raw text, ignoring case', () => {
    const filter = buildPrefilter('Hello World');
    expect(filter?.test('{"text":"say hello WORLD now"}')).toBe(true);
    expect(filter?.test('{"text":"hello there"}')).toBe(false);
  });

  it('is not made for a needle without a usable run, and for a run that could be in the truncation note', () => {
    for (const needle of ['', '   ', '{}', '":', '[],', 'truncated', 'chars', '...', '42', 'ed']) {
      expect(buildPrefilter(needle), JSON.stringify(needle)).toBeNull();
    }
  });

  it('cuts the needle at the characters that the display projection rewrites and keeps the longest run', () => {
    // the input of a tool call is printed by the legacy writer (`"file_path": "x"`), but the file holds `"file_path":"x"`
    const filter = buildPrefilter('"file_path": "src/a.ts"');
    expect(filter?.test('{"input":{"file_path":"src/a.ts"}}')).toBe(true);
    expect(filter?.test('{"input":{"other":"value"}}')).toBe(false);
    // a quote and a backslash inside a text are escaped in the file; the run keeps the part that is plain
    const quoted = buildPrefilter(`say "hi" to C:${BACKSLASH}temp`);
    expect(quoted?.test(JSON.stringify({ text: `please say "hi" to C:${BACKSLASH}temp now` }))).toBe(true);
    expect(quoted?.test(JSON.stringify({ text: 'please say hi' }))).toBe(false);
  });

  it('finds a needle with characters above ASCII written raw or as unicode escapes', () => {
    for (const needle of [`caf${E_ACUTE}`, CJK, EMOJI, `${SIGMA}x`, `a${EMOJI}b`]) {
      const filter = buildPrefilter(needle);
      expect(filter?.test(`{"text":"say ${needle} now"}`), needle).toBe(true);
      expect(filter?.test(`{"text":"say ${escapeUnits(needle)} now"}`), `${needle} escaped`).toBe(true);
      expect(filter?.test(`{"text":"say ${escapeUnits(needle, true)} now"}`), `${needle} escaped upper`).toBe(true);
    }
  });

  it('matches the escaped form of the other case of a letter', () => {
    const lower = buildPrefilter(`caf${E_ACUTE}`);
    const upper = buildPrefilter(`CAF${E_ACUTE.toUpperCase()}`);
    expect(lower?.test(escapeUnits(`CAF${E_ACUTE.toUpperCase()}`))).toBe(true);
    expect(upper?.test(escapeUnits(`caf${E_ACUTE}`))).toBe(true);
  });

  it('does not fold a sharp s to ss (documented limit of the case folding)', () => {
    expect(buildPrefilter(`stra${SHARP_S}e`)?.test('{"text":"strasse"}')).toBe(false);
    expect(buildPrefilter('strasse')?.test(`{"text":"stra${SHARP_S}e"}`)).toBe(false);
  });
});

describe('relationPatterns', () => {
  it('has one pattern per filter that needs the relation pass', () => {
    expect(relationPatterns({ errors: false, tool: null })).toEqual([]);
    const both = relationPatterns({ errors: true, tool: 'Bash' });
    expect(both).toHaveLength(2);
    expect(both[0]?.test('{"is_error": true}')).toBe(true);
    expect(both[0]?.test('{"is_error":false}')).toBe(false);
    expect(both[1]?.test('{"type":"tool_use","name":"Bash"}')).toBe(true);
    expect(both[1]?.test('{"type":"tool_use","name":"Bashful"}')).toBe(false);
  });
});

describe('keeps (the legacy /api/search rules)', () => {
  const tool = entry({ k: 'tool', id: 't1', name: 'Bash', summary: 'ls -la', input: '{"command": "ls -la"}' });
  const result = entry({ k: 'result', id: 't1', text: 'total 8', err: true });
  const relation = { badIds: new Set(['t1']), toolIds: new Set(['t1']) };

  it('looks for the needle in text, summary, input and name, joined by single spaces', () => {
    expect(haystackOf(tool)).toBe(' ls -la {"command": "ls -la"} Bash');
    expect(keeps(tool, criteria({ needle: 'bash' }), NO_RELATION)).toBe(true);
    expect(keeps(tool, criteria({ needle: 'command' }), NO_RELATION)).toBe(true);
    expect(keeps(result, criteria({ needle: 'total' }), NO_RELATION)).toBe(true);
    expect(keeps(result, criteria({ needle: 'nothing' }), NO_RELATION)).toBe(false);
  });

  it('restricts the kinds', () => {
    const only = criteria({ kinds: new Set<EntryKind>(['result']) });
    expect(keeps(result, only, NO_RELATION)).toBe(true);
    expect(keeps(tool, only, NO_RELATION)).toBe(false);
  });

  it('keeps failed results and their tool entries for errors', () => {
    const errors = criteria({ errors: true });
    expect(keeps(result, errors, NO_RELATION)).toBe(true);
    expect(keeps(entry({ k: 'result', id: 't2', text: 'ok', err: false }), errors, NO_RELATION)).toBe(false);
    expect(keeps(tool, errors, NO_RELATION)).toBe(false);
    expect(keeps(tool, errors, relation)).toBe(true);
    expect(keeps(entry({ k: 'say', text: 'failed' }), errors, relation)).toBe(false);
  });

  it('keeps tool entries of a name and their results for tool', () => {
    const named = criteria({ tool: 'Bash' });
    expect(keeps(tool, named, NO_RELATION)).toBe(true);
    expect(keeps(entry({ k: 'tool', id: 't9', name: 'Read' }), named, NO_RELATION)).toBe(false);
    expect(keeps(result, named, NO_RELATION)).toBe(false);
    expect(keeps(result, named, relation)).toBe(true);
    expect(keeps(entry({ k: 'result', text: 'no id' }), named, relation)).toBe(false);
  });

  it('does not fold a sharp s to ss', () => {
    expect(keeps(entry({ k: 'say', text: 'strasse' }), criteria({ needle: `stra${SHARP_S}e` }), NO_RELATION)).toBe(
      false,
    );
    expect(
      keeps(entry({ k: 'say', text: `Stra${SHARP_S}e` }), criteria({ needle: `stra${SHARP_S}e` }), NO_RELATION),
    ).toBe(true);
  });
});

describe('snippetOf', () => {
  it('starts 40 characters before the match and is 160 characters long', () => {
    const text = `${'a'.repeat(100)}NEEDLE${'b'.repeat(200)}`;
    const snippet = snippetOf(entry({ k: 'say', text }), 'needle');
    expect(snippet).toHaveLength(160);
    expect(snippet.startsWith(`${'a'.repeat(40)}NEEDLE`)).toBe(true);
  });

  it('starts at the beginning when the match is near it or absent from the shown text', () => {
    expect(snippetOf(entry({ k: 'say', text: 'short needle text' }), 'needle')).toBe('short needle text');
    expect(snippetOf(entry({ k: 'tool', name: 'NeedleTool', summary: 'plain summary' }), 'needletool')).toBe(
      'plain summary',
    );
    expect(snippetOf(entry({ k: 'say', text: 'abc' }), '')).toBe('abc');
  });

  it('takes text, else summary, else input, and counts code points', () => {
    expect(snippetOf(entry({ k: 'tool', summary: 'S', input: 'I' }), '')).toBe('S');
    expect(snippetOf(entry({ k: 'tool', input: 'I' }), '')).toBe('I');
    const emojis = EMOJI.repeat(200);
    expect(Array.from(snippetOf(entry({ k: 'say', text: emojis }), ''))).toHaveLength(160);
  });
});

describe('scanBlock', () => {
  function setup(
    records: readonly unknown[],
    over: Partial<ScanEnv> = {},
  ): { env: ScanEnv; offsets: number[]; end: number } {
    const path = join(makeTemp('scan').path, 'transcript.jsonl');
    const offsets = writeFile(
      path,
      records.map((record) => JSON.stringify(record)),
    );
    return { env: envOf(path, over), offsets, end: statSync(path).size };
  }

  const all = (needle = ''): { prefilter: RegExp | null; criteria: Criteria; relation: typeof NO_RELATION } => ({
    prefilter: needle === '' ? null : buildPrefilter(needle),
    criteria: criteria({ needle: needle.toLowerCase() }),
    relation: NO_RELATION,
  });

  async function run(
    env: ScanEnv,
    end: number,
    filter: ReturnType<typeof all>,
    room = 100,
    start = { entryIndex: 0, skip: 0, offset: 0 },
  ): Promise<{ outcome: BlockOutcome; hits: Hit[] }> {
    const hits: Hit[] = [];
    const outcome = await scanBlock(
      env,
      { start: start.offset, end, entryIndex: start.entryIndex, skip: start.skip },
      filter,
      hits,
      room,
    );
    return { outcome, hits };
  }

  it('numbers the entries from the block, gives the line offset and verifies each entry', async () => {
    const { env, offsets, end } = setup([
      user('first prompt'),
      say('an answer with the needle inside'),
      toolUse('t1', 'Bash', { command: 'echo needle' }),
      toolResult('t1', 'needle printed', false),
      say('closing words'),
    ]);
    const { outcome, hits } = await run(env, end, all('NEEDLE'), 100, { entryIndex: 10, skip: 0, offset: 0 });
    expect(outcome).toMatchObject({ status: 'done', bytes: end, entries: 5 });
    expect(hits.map((hit) => [hit.i, hit.k, hit.offset])).toEqual([
      [11, 'say', offsets[1]],
      [12, 'tool', offsets[2]],
      [13, 'result', offsets[3]],
    ]);
    expect(hits[1]).toMatchObject({ name: 'Bash', snippet: 'echo needle' });
  });

  it('skips a block without a hit unparsed and says so', async () => {
    const { env, end } = setup([user('nothing here'), say('and nothing there')]);
    const { outcome, hits } = await run(env, end, all('needle'));
    expect(outcome).toEqual({ status: 'done', bytes: end, entries: null });
    expect(hits).toEqual([]);
  });

  it('parses every line when there is no prefilter, and counts the lines that hold no entry', async () => {
    const { env, offsets, end } = setup([
      { type: 'queue-operation', operation: 'enqueue' },
      user('plain'),
      say('plain too'),
    ]);
    const { outcome, hits } = await run(env, end, all());
    expect(outcome).toMatchObject({ status: 'done', entries: 2 });
    expect(hits.map((hit) => [hit.i, hit.offset])).toEqual([
      [0, offsets[1]],
      [1, offsets[2]],
    ]);
  });

  it('stops at the room and resumes from the cut with the matches of the line already delivered skipped', async () => {
    const twoInOneLine = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'needle one' },
          { type: 'text', text: 'needle two' },
        ],
      },
    };
    const { env, end } = setup([user('needle zero'), twoInOneLine, say('needle three')]);
    const everything = await run(env, end, all('needle'));
    expect(everything.hits.map((hit) => hit.i)).toEqual([0, 1, 2, 3]);

    const pages: number[][] = [];
    let at = { entryIndex: 0, skip: 0, offset: 0 };
    for (let guard = 0; guard < 10; guard += 1) {
      const { outcome, hits } = await run(env, end, all('needle'), 2, at);
      pages.push(hits.map((hit) => hit.i));
      if (outcome.status !== 'cut') break;
      // the last match of a cut is the one a later page starts with
      pages[pages.length - 1]?.pop();
      at = { entryIndex: outcome.at.entryIndex, skip: outcome.at.skip, offset: outcome.at.offset };
    }
    expect(pages.flat()).toEqual([0, 1, 2, 3]);
  });

  it('finds a needle in a line longer than the read size, and only in the text the window would show', async () => {
    const filler = 'x'.repeat(5000);
    const { env, end } = setup(
      [
        user(`${filler} deep-needle ${filler}`),
        say('short'),
        user(`end-needle ${filler}${filler}`),
        user(`${filler}${filler} beyond-needle`),
      ],
      { chunkBytes: 1000 },
    );
    expect((await run(env, end, all('deep-needle'))).hits.map((hit) => hit.i)).toEqual([0]);
    expect((await run(env, end, all('end-needle'))).hits.map((hit) => hit.i)).toEqual([2]);
    expect((await run(env, end, all('absent-needle'))).hits).toEqual([]);
    // the legacy search looks at the displayed entry, which is clipped at `limits.text_chars` (6000): text beyond it is not searched
    expect((await run(env, end, all('beyond-needle'))).hits).toEqual([]);
  });

  it('finds the same entries in a file with raw characters and in one with unicode escapes (DA-T-S-3)', async () => {
    const texts = [
      `quote "inside" and ${BACKSLASH}back${BACKSLASH}slash`,
      `caf${E_ACUTE} au lait`,
      `CAF${E_ACUTE.toUpperCase()} AU LAIT`,
      `${CJK} text`,
      `smile ${EMOJI} here`,
      `Greek ${SIGMA}${SIGMA} sums`,
      'plain ascii only',
    ];
    const lines = texts.map((text) => JSON.stringify(say(text)));
    const dir = makeTemp('scan-escapes').path;
    writeFile(join(dir, 'raw.jsonl'), lines);
    writeFile(
      join(dir, 'escaped.jsonl'),
      lines.map((line) => escapeUnits(line)),
    );
    writeFile(
      join(dir, 'escaped-upper.jsonl'),
      lines.map((line) => escapeUnits(line, true)),
    );
    const needles = [
      'quote "inside"',
      `${BACKSLASH}back${BACKSLASH}slash`,
      `caf${E_ACUTE}`,
      `CAF${E_ACUTE.toUpperCase()}`,
      CJK,
      EMOJI,
      `smile ${EMOJI}`,
      `${SIGMA}${SIGMA}`,
      'ascii',
      'no such text',
    ];
    for (const needle of needles) {
      const found: number[][] = [];
      for (const name of ['raw.jsonl', 'escaped.jsonl', 'escaped-upper.jsonl']) {
        const path = join(dir, name);
        const { hits } = await run(envOf(path), statSync(path).size, all(needle));
        found.push(hits.map((hit) => hit.i));
      }
      const expected = texts.flatMap((text, i) => (text.toLowerCase().includes(needle.toLowerCase()) ? [i] : []));
      expect(found, JSON.stringify(needle)).toEqual([expected, expected, expected]);
    }
  });

  it('reports a file that ends before the block does', async () => {
    const { env, end } = setup([user('only line')]);
    expect((await run(env, end + 500, all('needle'))).outcome.status).toBe('short');
    expect((await run(env, end + 500, all())).outcome.status).toBe('short');
  });

  it('stops when the client goes away', async () => {
    const controller = new AbortController();
    const { env, end } = setup([user('needle')], { signal: controller.signal });
    controller.abort();
    expect((await run(env, end, all('needle'))).outcome.status).toBe('cancelled');
    expect((await run(env, end, all())).outcome.status).toBe('cancelled');
  });

  it('displays the same entries as the window would', async () => {
    const record = toolUse('t1', 'Read', { file_path: 'FIXTURE/a.txt' });
    const { env, end } = setup([record]);
    const { hits } = await run(env, end, all());
    const [shown] = displayEntries(record, { textChars: 6000 });
    expect(hits[0]).toMatchObject({ k: shown?.k, name: shown?.name, t: shown?.t });
  });
});

describe('scanRelation', () => {
  it('collects the ids of failed results and of the tool entries of one name', async () => {
    const path = join(makeTemp('relation').path, 'transcript.jsonl');
    writeFile(
      path,
      [
        user('prompt'),
        toolUse('t1', 'Bash', { command: 'false' }),
        toolResult('t1', 'boom', true),
        toolUse('t2', 'Read', { file_path: 'FIXTURE/a' }),
        toolResult('t2', 'fine', false),
        toolUse('t3', 'Bash', { command: 'true' }),
        toolResult('t3', 'fine', false),
      ].map((record) => JSON.stringify(record)),
    );
    const sets: RelationSets = { badIds: new Set<string>(), toolIds: new Set<string>() };
    const outcome = await scanRelation(
      envOf(path),
      statSync(path).size,
      relationPatterns({ errors: true, tool: 'Bash' }),
      { tool: 'Bash' },
      sets,
      () => null,
    );
    expect(outcome).toBe('done');
    expect([...sets.badIds]).toEqual(['t1']);
    expect([...sets.toolIds].sort()).toEqual(['t1', 't3']);
  });

  it('stops when told to and reports a file that is shorter than the index says', async () => {
    const path = join(makeTemp('relation-stop').path, 'transcript.jsonl');
    writeFile(path, [JSON.stringify(user('x'))]);
    const sets: RelationSets = { badIds: new Set<string>(), toolIds: new Set<string>() };
    const patterns = relationPatterns({ errors: true, tool: null });
    expect(await scanRelation(envOf(path), 10, patterns, { tool: null }, sets, () => 'time_budget')).toBe(
      'time_budget',
    );
    expect(await scanRelation(envOf(path), 10, patterns, { tool: null }, sets, () => 'cancelled')).toBe('cancelled');
    expect(await scanRelation(envOf(path), 5000, patterns, { tool: null }, sets, () => null)).toBe('short');
  });
});
