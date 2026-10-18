// Session classification (02 5.2, T-TR-14): the port of the legacy `classify` of `src/backend/sessions.py`. The table of
// cases below is frozen: the expected labels in `EXPECTED` were recorded from the legacy implementation (the oracle of
// T-TR-14), not hand-written guesses, and every pattern of the table is also a valid JavaScript pattern.
import { describe, expect, it } from 'vitest';

import {
  classify,
  compileSessionRules,
  realFirstPrompt,
  userTexts,
  type HeadRecord,
  type SessionRule,
} from './classify.ts';

// @cases-begin
interface Case {
  name: string;
  lines: Line[];
  rules: SessionRule[];
  pinned?: boolean;
}
type Line = Record<string, unknown> | string;
const BOILER_TEXT = '<system-reminder>caveat text</system-reminder>';
const user = (text: string): Line => ({ type: 'user', message: { role: 'user', content: text } });
const userBlocks = (...texts: string[]): Line => ({
  type: 'user',
  message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) },
});
const assistant = (text: string): Line => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolResult = (): Line => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
});
const fill = (n: number): Line[] => Array.from({ length: n }, () => '{"type":"system"}');
const junk = (n: number): Line[] => Array.from({ length: n }, () => 'not json');
const prompts = (n: number): Line[] => Array.from({ length: n }, (_, i) => user('prompt ' + String(i + 1)));
const emoji = String.fromCodePoint(0x1f600);
const FS = String.fromCharCode(0x1c);
const GS = String.fromCharCode(0x1d);
const FEFF = String.fromCharCode(0xfeff);
const CASES: Case[] = [
  { name: 'no rules: the first prompt is the label', lines: [assistant('hi'), user('Fix the login bug')], rules: [] },
  {
    name: 'a first-prompt rule with a group',
    lines: [user('Fix the login bug please')],
    rules: [{ match: '^Fix the ([a-z]+) bug', label: 'bug of {1}' }],
  },
  {
    name: 'the first matching rule wins',
    lines: [user('Fix the login bug')],
    rules: [
      { match: 'nothing here', label: 'zero' },
      { match: 'login', label: 'one' },
      { match: 'bug', label: 'two' },
    ],
  },
  {
    name: 'a rule without label or name is called session',
    lines: [user('Fix the login bug')],
    rules: [{ match: 'login' }],
  },
  {
    name: 'a rule name stands in for a missing label',
    lines: [user('Fix the login bug')],
    rules: [{ match: 'login', name: 'by name' }],
  },
  {
    name: 'scope any joins the first prompts',
    lines: [user('hello'), assistant('x'), user('later: deploy to staging now')],
    rules: [{ match: 'deploy to (prod|staging)', scope: 'any', label: 'deploy {1} {0}' }],
  },
  {
    name: 'the default scope looks at the first prompt only',
    lines: [user('hello'), user('later: deploy to staging now')],
    rules: [{ match: 'deploy to (prod|staging)', label: 'deploy {1}' }],
  },
  {
    name: '{0} is the first 40 code points of the match',
    lines: [user(emoji.repeat(50) + 'tail')],
    rules: [{ match: '.+', label: '<{0}>' }],
  },
  {
    name: 'an unmatched label is cut at 70 code points',
    lines: [user('x'.repeat(69) + emoji + 'tail')],
    rules: [],
  },
  {
    name: 'a multi-line first prompt becomes one line',
    lines: [user('  first line\nsecond line  ')],
    rules: [],
  },
  {
    name: 'strip uses the Python whitespace set',
    lines: [user(FS + 'hello' + GS)],
    rules: [],
  },
  {
    name: 'a leading byte order mark stays in the label',
    lines: [user(FEFF + 'bom text')],
    rules: [],
  },
  {
    name: 'only boilerplate: the label is the first boilerplate text',
    lines: [user(BOILER_TEXT), user('<local-command-stdout>x</local-command-stdout>')],
    rules: [],
  },
  { name: 'boilerplate first, then a real prompt', lines: [user(BOILER_TEXT), user('Real prompt')], rules: [] },
  {
    name: 'every text block of a record is a prompt',
    lines: [userBlocks('<ide_selection>a</ide_selection>', 'Second block', 'Third block')],
    rules: [{ match: 'Third', scope: 'any', label: 'third' }],
  },
  { name: 'tool results are not prompts', lines: [toolResult(), user('Prompt after result')], rules: [] },
  { name: 'an empty prompt is skipped', lines: [user(''), user('Second')], rules: [] },
  { name: 'invalid lines consume an index', lines: [...junk(5), user('After junk')], rules: [] },
  { name: 'line index 400 is the last one read', lines: [...junk(400), user('At 400')], rules: [] },
  { name: 'line index 401 is not read', lines: [...junk(401), user('At 401')], rules: [] },
  { name: 'the first user text is read up to index 120', lines: [...fill(120), user(BOILER_TEXT)], rules: [] },
  { name: 'boilerplate at index 121 is not seen', lines: [...fill(121), user(BOILER_TEXT)], rules: [] },
  {
    name: 'prompts stop at the next line once 25 are collected',
    lines: prompts(30),
    rules: [{ match: 'prompt 26', scope: 'any', label: 'late' }],
  },
  {
    name: 'prompts of one record are all collected',
    lines: [userBlocks(...Array.from({ length: 30 }, (_, i) => 'block ' + String(i + 1)))],
    rules: [{ match: 'block 30', scope: 'any', label: 'late block' }],
  },
  {
    name: 'a rule that does not compile is skipped',
    lines: [user('Fix the login bug')],
    rules: [
      { match: '(unclosed', label: 'bad' },
      { match: 'login', label: 'good' },
    ],
  },
  { name: 'no prompt at all', lines: [assistant('hi')], rules: [] },
  { name: 'a pinned session is matched', lines: [user('Some prompt')], rules: [], pinned: true },
  {
    name: 'a dot matches a newline',
    lines: [user('first\nsecond')],
    rules: [{ match: 'first.*second', label: 'multi' }],
  },
];
// @cases-end

// the printout of the legacy module for CASES (scratch script, 2026-10-12): label, matched, real_first_prompt
const EXPECTED: Record<string, { label: string; matched: boolean; first: string } | undefined> = {
  'no rules: the first prompt is the label': { label: 'Fix the login bug', matched: false, first: 'Fix the login bug' },
  'a first-prompt rule with a group': { label: 'bug of login', matched: true, first: 'Fix the login bug please' },
  'the first matching rule wins': { label: 'one', matched: true, first: 'Fix the login bug' },
  'a rule without label or name is called session': { label: 'session', matched: true, first: 'Fix the login bug' },
  'a rule name stands in for a missing label': { label: 'by name', matched: true, first: 'Fix the login bug' },
  'scope any joins the first prompts': { label: 'deploy staging deploy to staging', matched: true, first: 'hello' },
  'the default scope looks at the first prompt only': { label: 'hello', matched: false, first: 'hello' },
  '{0} is the first 40 code points of the match': {
    label: '<😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀>',
    matched: true,
    first: '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀tail',
  },
  'an unmatched label is cut at 70 code points': {
    label: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀',
    matched: false,
    first: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx😀tail',
  },
  'a multi-line first prompt becomes one line': {
    label: 'first line second line',
    matched: false,
    first: '  first line\nsecond line  ',
  },
  'strip uses the Python whitespace set': { label: 'hello', matched: false, first: '\u001chello\u001d' },
  'a leading byte order mark stays in the label': { label: '﻿bom text', matched: false, first: '﻿bom text' },
  'only boilerplate: the label is the first boilerplate text': {
    label: '<system-reminder>caveat text</system-reminder>',
    matched: false,
    first: '<system-reminder>caveat text</system-reminder>',
  },
  'boilerplate first, then a real prompt': { label: 'Real prompt', matched: false, first: 'Real prompt' },
  'every text block of a record is a prompt': { label: 'third', matched: true, first: 'Second block' },
  'tool results are not prompts': { label: 'Prompt after result', matched: false, first: 'Prompt after result' },
  'an empty prompt is skipped': { label: 'Second', matched: false, first: 'Second' },
  'invalid lines consume an index': { label: 'After junk', matched: false, first: 'After junk' },
  'line index 400 is the last one read': { label: 'At 400', matched: false, first: 'At 400' },
  'line index 401 is not read': { label: '(no prompt)', matched: false, first: '' },
  'the first user text is read up to index 120': {
    label: '<system-reminder>caveat text</system-reminder>',
    matched: false,
    first: '<system-reminder>caveat text</system-reminder>',
  },
  'boilerplate at index 121 is not seen': { label: '(no prompt)', matched: false, first: '' },
  'prompts stop at the next line once 25 are collected': { label: 'prompt 1', matched: false, first: 'prompt 1' },
  'prompts of one record are all collected': { label: 'late block', matched: true, first: 'block 1' },
  'a rule that does not compile is skipped': { label: 'good', matched: true, first: 'Fix the login bug' },
  'no prompt at all': { label: '(no prompt)', matched: false, first: '' },
  'a pinned session is matched': { label: 'Some prompt', matched: true, first: 'Some prompt' },
  'a dot matches a newline': { label: 'multi', matched: true, first: 'first\nsecond' },
};

function headOf(lines: readonly Line[]): { head: HeadRecord[]; linesSeen: number } {
  const head: HeadRecord[] = [];
  lines.slice(0, 401).forEach((line, index) => {
    const text = typeof line === 'string' ? line : JSON.stringify(line);
    try {
      head.push({ lineNo: index + 1, record: JSON.parse(text) as unknown });
    } catch {
      // an invalid line holds its place (it consumes an index) and nothing else
    }
  });
  return { head, linesSeen: Math.min(lines.length, 401) };
}

describe('classify against the legacy module (T-TR-14)', () => {
  it('has an expected result for every case', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(CASES.map((c) => c.name).sort());
  });

  for (const c of CASES) {
    it(c.name, () => {
      const { head, linesSeen } = headOf(c.lines);
      const result = classify(head, compileSessionRules(c.rules), { pinned: c.pinned === true, linesSeen });
      const expected = EXPECTED[c.name];
      expect({ label: result.label, matched: result.matched }).toEqual({
        label: expected?.label,
        matched: expected?.matched,
      });
      expect(realFirstPrompt(head)).toBe(expected?.first);
    });
  }
});

describe('classify results of the new engine', () => {
  const rules: SessionRule[] = [
    { match: 'nothing', label: 'zero' },
    { match: 'login', label: 'one' },
  ];

  it('reports the index of the matching rule and the label source', () => {
    const { head, linesSeen } = headOf([user('Fix the login bug')]);
    expect(classify(head, compileSessionRules(rules), { pinned: false, linesSeen })).toMatchObject({
      label: 'one',
      matched: true,
      ruleIndex: 1,
      labelSource: 'rule',
    });
  });

  it('skips a rule written in Python regex syntax like any invalid rule, and the next rule applies', () => {
    const { head, linesSeen } = headOf([user('Fix the login bug')]);
    const compiled = compileSessionRules([
      { match: '(?P<area>login)', label: 'python {1}' },
      { match: '(?<area>login)', label: 'javascript {1}' },
    ]);
    expect(compiled[0]?.regex).toBeNull();
    expect(classify(head, compiled, { pinned: false, linesSeen })).toMatchObject({
      label: 'javascript login',
      ruleIndex: 1,
      labelSource: 'rule',
    });
  });

  it('keeps the index of a rule that does not compile, so the numbers stay those of the configuration', () => {
    const { head, linesSeen } = headOf([user('Fix the login bug')]);
    const compiled = compileSessionRules([
      { match: '(unclosed', label: 'bad' },
      { match: 'login', label: 'good' },
    ]);
    expect(compiled).toHaveLength(2);
    expect(classify(head, compiled, { pinned: false, linesSeen })).toMatchObject({ label: 'good', ruleIndex: 1 });
  });

  it('says first_prompt for an unmatched label, none without a prompt, and keeps no rule index', () => {
    const one = headOf([user('Some prompt')]);
    expect(classify(one.head, [], { pinned: false, linesSeen: one.linesSeen })).toMatchObject({
      label: 'Some prompt',
      matched: false,
      ruleIndex: null,
      labelSource: 'first_prompt',
    });
    const none = headOf([assistant('hi')]);
    expect(classify(none.head, [], { pinned: false, linesSeen: none.linesSeen })).toMatchObject({
      label: '(no prompt)',
      labelSource: 'none',
    });
  });

  it('counts the head lines seen, at most 401', () => {
    const few = headOf([user('a'), 'junk']);
    expect(classify(few.head, [], { pinned: false, linesSeen: few.linesSeen }).classifiedLines).toBe(2);
    const many = headOf([...junk(500), user('late')]);
    expect(classify(many.head, [], { pinned: false, linesSeen: many.linesSeen }).classifiedLines).toBe(401);
  });

  it('collects at most the user texts of the head, boilerplate excluded', () => {
    const { head } = headOf([user(BOILER_TEXT), userBlocks('a', '', 'b'), assistant('x'), toolResult()]);
    expect(userTexts(head)).toEqual(['a', 'b']);
  });

  it('lets a pinned session keep its rule label and still be matched', () => {
    const { head, linesSeen } = headOf([user('Fix the login bug')]);
    expect(classify(head, compileSessionRules(rules), { pinned: true, linesSeen })).toMatchObject({
      label: 'one',
      matched: true,
      labelSource: 'rule',
    });
  });
});
