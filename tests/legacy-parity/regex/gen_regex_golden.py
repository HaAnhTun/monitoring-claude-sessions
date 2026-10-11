#!/usr/bin/env python3
"""Generator of the Python-regex golden data (design 01 section 2.8, ADR 0002). Dev tool, run by hand or by the WP-05 gate.

    PYTHONDONTWRITEBYTECODE=1 python -B gen_regex_golden.py [--out DIR]

Writes exactly two files into DIR (default: the folder of this script):

* regex-golden.json   {meta, cases[], classes[]}: patterns with inputs and the results CPython produced
                      (null | {span, groups, groupdict}, offsets in code points), plus a Unicode class sweep.
* regex-rejects.json  {meta, rejects[]}: patterns the Node translator must refuse, with the documented error code and
                      the CPython error text (null when CPython accepts the pattern).

Context semantics follow the legacy engine: `session_rule` is re.search(pattern, text, re.S), `attempts` is
re.compile(pattern).match(text). The output is deterministic (fixed seed, no timestamps), so regenerating into a
scratch folder and diffing proves that the committed data still comes from Python. Corpus parts: `table` (one or more
cases per row of the supported table of 2.8), `v9` (synthetic patterns with the construct inventory of a real chain
task: named groups, ^ at position 0, ranges, counted quantifiers, greedy +, lazy *?, dot under DOTALL, one plain
group; all names and texts are invented), `random` (seeded grammar, inputs from each pattern's AST plus mutations).
It uses only the standard library and writes no bytecode.
"""
import argparse
import json
import os
import random
import re
import sys
import unicodedata
import warnings

warnings.simplefilter('ignore')  # CPython FutureWarnings about possible nested sets are expected for the rejects

SEED = 20261011
BS = chr(92)
MAX_CP = 0x110000


def cps(*codes):
    return ''.join(chr(c) for c in codes)


# ---- edge inputs ---------------------------------------------------------------------------------------------
EDGE_INPUTS = [
    '', 'a', 'A', 'ab', 'a b', ' ', '_', '0', '9', 'abc', 'ABC abc', 'foo123bar', 'foo_bar-baz', 'aaa', 'x.y', 'a{b',
    'a' + chr(10), 'a' + chr(13), 'a' + chr(13) + chr(10), 'a' + chr(10) + 'b', chr(10), chr(10) + 'a', 'a' + chr(10) * 2,
    'a' + chr(0x2028) + 'b', 'a' + chr(0x85) + 'b', chr(0xFEFF) + 'a', 'a' + chr(0xA0) + 'b', 'a' + chr(0x3000) + 'b',
    'a' + chr(9) + 'b', 'a' + chr(11) + 'b', 'a' + chr(0x1C) + 'b', 'a' + chr(0x1F) + 'b', chr(0),
    cps(0xE9), cps(0xC9), 'e' + cps(0x301), cps(0x663), 'a' + cps(0x663) + 'b', cps(0xB2), cps(0x2167), cps(0x1F600),
    'x' + cps(0x1F600) + 'y', cps(0x1D49C) + 'b', cps(0x1C5), cps(0x17F), cps(0x212A), cps(0x130), cps(0x131),
    cps(0xDF), cps(0x20AC), cps(0xE4), cps(0x65E5, 0x672C), 'iI' + cps(0x130, 0x131), 'kK' + cps(0x212A), 'sS' + cps(0x17F),
    'a-b', 'a,b', '(a)', '[a]', 'a|b',
]

# ---- supported table (2.8): one row per construct, edge inputs added by the generator ----------------------------
S = 'session_rule'
A = 'attempts'
HEX = lambda n: BS + 'u' + format(n, '04x')


def row(pattern, ctxs=(S, A), extra=()):
    return [(pattern, ctx, list(extra)) for ctx in ctxs]


TABLE = []
# literals and escaped punctuation
for p in ['abc', r'a\.c', r'a\[b', r'\(x\)', r'x\|y', r'\{', 'a{', 'a{}', 'a{b}', 'a{1', 'a{,}x', 'a{1,x}', '}', ']', r'\-', r'\/',
          r'\ ', r'\#', cps(0xE9), cps(0x65E5, 0x672C), cps(0x1F600), BS + cps(0xE9), r'a\*', r'\^\$', 'a-b', r'\\']:
    TABLE += row(p)
# str-pattern escapes
for p in [r'\a', r'a\tb', r'\n', r'\r', r'\f', r'\v', r'\x41', r'\x00', r'\xe9', BS + 'u0041', BS + 'u00e9', BS + 'u2028',
          BS + 'U0001F600', BS + 'U00000041', r'\0', r'\012', r'\101', r'\377', r'\0a', r'\00', r'\1011', r'a\ab']:
    TABLE += row(p)
# dot
for p in ['.', 'a.b', '.*', '.+?x', '(?s).', '(?s)a.b', '(?s).*?c', 'a.', '..']:
    TABLE += row(p)
# anchors
for p in ['^a', 'a$', '^$', '^', '$', '(?m)^a', '(?m)a$', '(?m)^$', '(?m)^', '(?m)$', r'\Aa', r'a\Z', r'^a\Z', r'(?m)\Aa', r'a$|b$',
          '^a|^b', '(?m)^a|b$', 'a$b', r'\Z', r'\A']:
    TABLE += row(p)
# classes and boundaries
for p in [r'\d', r'\D', r'\w', r'\W', r'\s', r'\S', r'(?a)\d', r'(?a)\w', r'(?a)\s', r'(?a)\D', r'(?a)\W', r'(?a)\S', r'\b', r'\B',
          r'\bfoo\b', r'(?a)\bfoo\b', r'a\b', r'\Bx', r'\d+', r'\w+', r'\s+', r'[\d]+', r'\b\w+\b', r'(?a)\b\w+\b', r'\W+', r'(?u)\w+',
          r'(?u)\d', r'(?a:\w)\w', r'\w(?a:\w)', r'(?a)(?:\w)', r'\w\b\W']:
    TABLE += row(p)
# sets
for p in ['[abc]', '[^abc]', '[a-z]', '[a-zA-Z0-9_]', '[]a]', '[^]a]', '[a-]', '[-a]', r'[a\-z]', r'[\d.]', r'[\w-]', r'[^\s]', r'[\D\W]',
          r'[\b]', '[.]', '[$^]', r'[a\]b]', r'[\x41-\x5a]', '[' + BS + 'u00e0-' + BS + 'u00ff]', '[a-a]', r'[\-]', '[|]', '[(]', '[ ]',
          '[' + cps(0xE9) + ']', '[a-c-e]', '[!-/]', r'[\s\S]', r'[^\s\S]', r'[\d\s]', r'[^\d\s]', r'[\W\d]', r'[\w\s-]+', r'[a-z0-9_.-]+',
          r'[^\n]', '[\\n]', r'[\0]', r'[\101-\103]', '[{]', '[}]', '[*+?]', '[^^]', '[a^]', '[%&~]', '[a&b]', '[a~b]', '[a|b]']:
    TABLE += row(p)
# groups and references
for p in ['(a)', '(?:a)', '(?P<n>a)', '(a)(b)', '(a(b))', '(?P<x>a)(?P<y>b)', r'(a)\1', r'(?P<n>a)(?P=n)', r'(a)(b)\2\1', r'(\w)\1', r'(a)(?:b)\1',
          r'((a)b)\2', r'(?P<q>\w+) (?P=q)', r'(a*)b\1', '(a?)b', '(a)?b', '(a|b)c', '(a|b)+', '(?:a|b)+', '((a)|(b))', '(a)(?:(b))',
          '(?P<one>a)|(?P<two>b)', r'(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\10']:
    TABLE += row(p)
# lookarounds
for p in ['a(?=b)', 'a(?!b)', '(?<=a)b', '(?<!a)b', '(?<=ab|cd)e', '(?=a)', '(?!)', r'(?<=\d{2})x', '(?=a)a', '(?!a)b', '(?<=^a)b', '(?<!^)b',
          r'(?<=\b)a', r'(?<=a)(?<=a)b', '(?<=.)b', '(?<![a-c])x', '(?=(a))a', '(?=(?P<n>a))a', 'a(?=b|c)',
          'a(?=b(?=c))', r'\w+(?=,)', r'(?<=,)\w+']:
    TABLE += row(p)
# comments
for p in ['a(?#c)b', 'a(?#c)*', '(?#c)a', 'a(?#)b']:
    TABLE += row(p)
# quantifiers
for p in ['a*', 'a+', 'a?', 'a{2}', 'a{2,}', 'a{,3}', 'a{2,3}', 'a*?', 'a+?', 'a??', 'a{2,3}?', 'a{2}?', '(?:ab)+', '(ab)*', 'a{0}', 'a{1,1}',
          '(a|b)*c', 'a{0,}', 'a{,}', 'a{ 1}', 'a{1 }', 'x{2}y{3}', '(?:a|b){2}', 'a.{2}b', '.{3}', '.{2,3}?c', r'\d{2,3}', r'[ab]{2}', r'\w{1,}?x',
          'a*b*', '(?:a+)+', '(?:ab?)*c', '(?:a|b)?c', r'(?:\d+\.)+', 'a{1}b{0,1}', 'a{0,0}', 'a{3}']:
    TABLE += row(p)
# flags
for p in ['(?i)abc', '(?i)[a-z]+', '(?i)i', '(?i)I', '(?i)[^i]', '(?i)[h-j]', '(?i)k', '(?i)s', '(?i)[^a-z]', '(?i)[^k]', '(?i)[^s]', '(?i)[a-z]', '(?i)[A-Z]',
          '(?s).', '(?m)^x', '(?is)a.b', '(?im)^a$', '(?i:a)b', 'a(?i:b)c', '(?i)(?-i:x)', '(?i)a(?-i:b)c', '(?s)(?-s:.)', '(?s:.)', '(?m:^a$)', '(?-s:.)',
          '(?i)[i]', '(?i)[^i-k]', '(?i)[a-hj-z]', '(?i)ISK', '(?i)\\w', '(?i)\\W', '(?i)\\d+', '(?i)[\\w]', '(?i)[^\\w]', '(?i)\\bfoo\\b', '(?i)f(?:o|O)o',
          '(?i)(i)(?-i:i)', '(?ims)a.b', '(?s)(?m)a$', '(?u)a', '(?u:a)', '(?i)[^I]', '(?i)[I-K]']:
    TABLE += row(p)
# uppercase ASCII letters under a scoped IGNORECASE switch, IGNORECASE with the word class
for p in ['(?i:A)b', '(?i:K)s', '(?i:S)', '(?i:I)', '(?i:[K])', '(?i:[A-C])d', '(?i:[Q-T])', '(?i:[^A])', '(?i)(?-i:K)(?i:S)',
          '(?i)A(?-i:B)', '(?-i:K)', '(?i)\\w\\b', '(?i)[^\\W]a', '(?i)\\B', '(?i)\\W+', '(?i)[\\w]', '(?i)\\bK\\b']:
    TABLE += row(p, extra=[cps(0x345), 'a' + cps(0x345), cps(0x345) + 'a', 'K' + cps(0x345), 'kK' + cps(0x212A), 'sS' + cps(0x17F), 'Ab', 'ab', 'AB'])
# scoped ASCII/Unicode switches: exact for attempts (re.match), refused for session_rule (re.search pre-filter)
SWITCH_INPUTS = [cps(0x3000) + 'k', cps(0x663) + 'x', cps(0xE9) + 'x', 'k' + cps(0x3000), cps(0x663), cps(0xE9)]
for p in [r'(?a:\S)x', r'(?a:\S)', r'(?a:\D)', r'(?a:\W)', r'(?a:[^\d])', r'(?a)(?u:\d)', r'(?a)(?u:\w)', r'(?a)(?u:\S)', r'(?a:(?u:\d))']:
    TABLE += row(p, ctxs=(A,), extra=SWITCH_INPUTS)
for p in [r'(?a:\w)', r'(?a:\d)', r'(?a:\s+)x', r'(?a)(?a:\S)', r'(?u)(?u:\S)', r'(?u)\S(?a:\d)', r'(?a)\S', r'(?u)(?a:\w)\W']:
    TABLE += row(p, extra=SWITCH_INPUTS)
# alternation
for p in ['a|b', 'a|', '|a', '(a|)', 'a|b|c', '(?:a|ab)(?:c|bcd)', '^a|b$', '(a)|b', '(?:a|b)c', 'ab|a', 'a|ab', '(a|ab)(c|bcd)(d*)', '()', '(|a)b',
          '(?:)', 'a||b', '(a|b|)c', '(?:a|b|c)+', '(?:ab|cd)+e']:
    TABLE += row(p)
# labels (applyLabelTemplate consumers)
for p in [r'run-build[.]md.*?STEP=([A-Z0-9]+)', r'job (\w+) (\d+)', r'(?P<a>\w+)-(?P<b>\w+)']:
    TABLE += row(p, extra=['please run-build.md now STEP=AB12 go', 'job alpha 42 done', 'left-right', 'run-build.md' + chr(10) + 'STEP=Z9'])

# ---- synthetic replica of a real chain task (construct inventory only; every name and text is invented) ----------
V9_START = ('^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) BEGIN try (?P<n>[0-9]+) model (?P<model>[a-z]+) '
            'effort (?P<effort>[a-z]+)')
V9_END = '^(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}) JOB (?P<part>[A-Z0-9]+) END code=(?P<exit>[0-9]+) state=(?P<status>[A-Z ]+)'
V9_ATTEMPT_LINES = [
    '2026-01-02 03:04:05 JOB A1 BEGIN try 1 model alpha effort high',
    '2026-01-02 03:04:05 JOB A1 BEGIN try 12 model alpha effort high trailing words',
    '2026-01-02 03:04:05 JOB B22 BEGIN try 3 model beta effort low',
    '2026-01-02 03:04:05 JOB a1 BEGIN try 1 model alpha effort high',
    '2026-01-02 03:04:05 JOB A1 BEGIN try x model alpha effort high',
    '2026-01-02 03:04 JOB A1 BEGIN try 1 model alpha effort high',
    ' 2026-01-02 03:04:05 JOB A1 BEGIN try 1 model alpha effort high',
    '2026-01-02 03:04:05 JOB A1 END code=0 state=DONE',
    '2026-01-02 03:04:05 JOB A1 END code=137 state=KILLED BY TIMEOUT',
    '2026-01-02 03:04:05 JOB A1 END code=0 state=done',
    '2026-01-02 03:04:05 JOB A1 END code= state=DONE',
    '2026-01-02 03:04:05 JOB A1 END code=1 state=FAILED' + chr(10),
    '2026-01-02 03:04:05 JOB A1 END code=1 state=FAILED' + chr(13) + chr(10),
    '2026-01-02 03:04:05 JOB A1 END code=1 state=' + cps(0xC9, 0x1F600),
    cps(0x661, 0x662) + '26-01-02 03:04:05 JOB A1 BEGIN try 1 model alpha effort high',
    'noise line', '', '2026-01-02 03:04:05 something else',
]
V9_RULES = [
    ('run-job[.]md.*?PART=([A-Z0-9]+)', S),
    ('^Please run (?P<kind>[a-z-]+) now.*?ID=(?P<id>[0-9a-f]{8})', S),
    ('^You are the (?P<role>[A-Za-z ]+) agent.{0,20}?step (?P<step>[0-9]+)', S),
    ('step=([0-9]+).*?model=([a-z]+)', S),
    ('^[A-Z][a-z]+ [a-z]+ [0-9]{3}', S),
    ('(?P<verb>run|build|test) (?P<what>[a-z.]+)', S),
    ('^(?P<a>[a-z]+) (?P<b>[a-z]+)$', S),
    ('^.*?finish[.].*$', S),
    ('first.+second.+third', S),
    ('^[0-9]{4}-[0-9]{2}-[0-9]{2}', S),
]
V9_PROMPTS = [
    'Please run run-job.md now and report PART=AB12 afterwards',
    'run-job.md' + chr(10) + chr(10) + 'PART=Z9',
    'Please run build-check now, ID=0a1b2c3d, thanks',
    'Please run build-check now, ID=0A1B2C3D, thanks',
    'You are the Reviewer agent. Work on step 7 please',
    'You are the Planner agent with a very long preamble that exceeds the window step 7',
    'step=12 model=alpha',
    'step=12' + chr(10) + 'model=alpha',
    'Alpha beta 123 rest', 'alpha beta 123', 'run build', 'build main.rs now', 'test x',
    'hello world', 'hello' + chr(10) + 'world', 'a b', 'a b c',
    'start. finish. end', 'x finish. y', 'finish.',
    'first and second and third', 'first' + chr(10) + 'second' + chr(10) + 'third', 'second first third',
    '2026-01-02 note', ' 2026-01-02', '26-01-02',
    cps(0xC9) + 'tape ' + cps(0x1F600), '', 'x' * 200,
]


def v9_cases():
    out = []
    for p in (V9_START, V9_END):
        out.append((p, A, list(V9_ATTEMPT_LINES)))
    for p, ctx in V9_RULES:
        out.append((p, ctx, list(V9_PROMPTS)))
    return out


# ---- random grammar ------------------------------------------------------------------------------------------
LIT_POOL = list('abcxyzABC019 _-:,') + [cps(0xE9), cps(0x1F600)]
SAMPLE_POOL = list('abcxyzABC019 _-.:,') + [chr(10), chr(13), chr(9), cps(0xE9), cps(0xC9), cps(0x663), cps(0x1F600), cps(0x2028), cps(0x85),
                                           cps(0xA0), cps(0x130), cps(0x131), cps(0x17F), cps(0x212A), cps(0x1C5), cps(0xDF), cps(0x1D49C)]
SPECIAL = set('.\\[{()*+?^$|')


def esc_lit(ch):
    if ch in SPECIAL:
        return BS + ch
    return ch


class Gen:
    def __init__(self, rng):
        self.rng = rng
        self.groups = []      # closed group indexes usable by backrefs
        self.open = 0
        self.count = 0
        self.names = 0
        self.icase = False

    def lit(self):
        pool = [c for c in LIT_POOL if not (self.icase and ord(c) > 127)]
        ch = self.rng.choice(pool)
        return esc_lit(ch), ('lit', ch)

    def cls(self):
        rng = self.rng
        items, nodes = [], []
        for _ in range(rng.randint(1, 3)):
            k = rng.random()
            if k < 0.5:
                ch = rng.choice([c for c in 'abcxyzABC019_.' if True])
                items.append(esc_lit(ch) if ch in '.' else ch)
                nodes.append(('lit', ch))
            elif k < 0.8:
                lo, hi = rng.choice([('a', 'c'), ('x', 'z'), ('A', 'C'), ('0', '9'), ('a', 'z'), ('b', 'b')])
                items.append(lo + '-' + hi)
                nodes.append(('range', lo, hi))
            else:
                c = rng.choice(['d', 'w', 's', 'D', 'W', 'S'])
                items.append(BS + c)
                nodes.append(('cat', c))
        neg = rng.random() < 0.25
        return '[' + ('^' if neg else '') + ''.join(items) + ']', ('cls', neg, nodes)

    def atom(self, depth, fixed=False):
        rng = self.rng
        k = rng.random()
        if k < 0.38:
            return self.lit()
        if k < 0.46:
            return '.', ('any',)
        if k < 0.64:
            return self.cls()
        if k < 0.76:
            c = rng.choice(['d', 'w', 's', 'D', 'W', 'S'])
            return BS + c, ('cat', c)
        if fixed or depth >= 2:
            return self.lit()
        if k < 0.9:
            return self.group(depth)
        if k < 0.95 and self.groups:
            idx = rng.choice(self.groups)
            return BS + str(idx), ('backref', idx)
        return self.lit()

    def group(self, depth):
        rng = self.rng
        kind = rng.random()
        if kind < 0.45:
            self.count += 1
            idx = self.count
            self.open += 1
            body, node = self.alt(depth + 1)
            self.open -= 1
            self.groups.append(idx)
            return '(' + body + ')', ('group', idx, node)
        if kind < 0.75:
            self.count += 1
            idx = self.count
            self.names += 1
            name = 'g%d' % self.names
            body, node = self.alt(depth + 1)
            self.groups.append(idx)
            return '(?P<' + name + '>' + body + ')', ('group', idx, node)
        body, node = self.alt(depth + 1)
        return '(?:' + body + ')', ('ncgroup', node)

    def quantified(self, depth):
        src, node = self.atom(depth)
        if node[0] in ('backref',):
            return src, node
        if self.rng.random() < 0.35:
            q, lo, hi = self.rng.choice([('*', 0, None), ('+', 1, None), ('?', 0, 1), ('{2}', 2, 2), ('{1,3}', 1, 3), ('{,2}', 0, 2), ('{2,}', 2, None)])
            lazy = self.rng.random() < 0.3
            return src + q + ('?' if lazy else ''), ('rep', node, lo, hi)
        return src, node

    def seq(self, depth):
        rng = self.rng
        parts, nodes = [], []
        if rng.random() < 0.15:
            a, n = rng.choice([('^', ('bol',)), (BS + 'b', ('wb',)), (BS + 'B', ('nwb',)), (BS + 'A', ('bos',))])
            parts.append(a)
            nodes.append(n)
        for _ in range(rng.randint(1, 4)):
            if rng.random() < 0.1 and depth < 2:
                look, node = self.look(depth)
                parts.append(look)
                nodes.append(node)
            else:
                s, n = self.quantified(depth)
                parts.append(s)
                nodes.append(n)
        if rng.random() < 0.15:
            a, n = rng.choice([('$', ('eol',)), (BS + 'Z', ('eos',)), (BS + 'b', ('wb',))])
            parts.append(a)
            nodes.append(n)
        return ''.join(parts), ('seq', nodes)

    def look(self, depth):
        rng = self.rng
        kind = rng.choice(['(?=', '(?!', '(?<=', '(?<!'])
        if kind.startswith('(?<'):
            body, node = self.fixed(rng.randint(1, 2))
        else:
            body, node = self.seq(depth + 1)
        return kind + body + ')', ('look', kind, node)

    def fixed(self, n):
        parts, nodes = [], []
        for _ in range(n):
            if self.rng.random() < 0.6:
                s, nd = self.lit()
            else:
                s, nd = self.cls()
            parts.append(s)
            nodes.append(nd)
        return ''.join(parts), ('seq', nodes)

    def alt(self, depth):
        rng = self.rng
        if rng.random() < 0.3:
            bodies = [self.seq(depth) for _ in range(rng.randint(2, 3))]
            return '|'.join(b[0] for b in bodies), ('alt', [b[1] for b in bodies])
        return self.seq(depth)


def sample(node, rng, caps):
    """A string that tends to match `node`; caps maps group index to its last sampled text."""
    kind = node[0]
    if kind == 'lit':
        return node[1]
    if kind == 'any':
        return rng.choice(SAMPLE_POOL)
    if kind == 'cat':
        pools = {'d': '0123' + cps(0x663), 'w': 'abZ_9' + cps(0xE9), 's': ' ' + chr(10) + chr(9), 'D': 'ab ', 'W': ' -.', 'S': 'ab1'}
        return rng.choice(pools[node[1]])
    if kind == 'range':
        return chr(rng.randint(ord(node[1]), ord(node[2])))
    if kind == 'cls':
        neg, items = node[1], node[2]
        if neg:
            return rng.choice(SAMPLE_POOL)
        return sample(rng.choice(items), rng, caps)
    if kind == 'seq':
        return ''.join(sample(n, rng, caps) for n in node[1])
    if kind == 'alt':
        return sample(rng.choice(node[1]), rng, caps)
    if kind == 'group':
        text = sample(node[2], rng, caps)
        caps[node[1]] = text
        return text
    if kind == 'ncgroup':
        return sample(node[1], rng, caps)
    if kind == 'rep':
        lo, hi = node[2], node[3]
        n = rng.randint(lo, (hi if hi is not None else lo + 3))
        return ''.join(sample(node[1], rng, caps) for _ in range(n))
    if kind == 'backref':
        return caps.get(node[1], '')
    return ''  # anchors and lookarounds contribute nothing


def mutate(text, rng):
    chars = list(text)
    for _ in range(rng.randint(1, 2)):
        op = rng.random()
        pos = rng.randint(0, len(chars))
        if op < 0.4 and chars:
            chars[min(pos, len(chars) - 1)] = rng.choice(SAMPLE_POOL)
        elif op < 0.7:
            chars.insert(pos, rng.choice(SAMPLE_POOL))
        elif chars:
            del chars[min(pos, len(chars) - 1)]
    return ''.join(chars)


def random_cases(rng, count=200, per=50):
    out = []
    attempts = 0
    while len(out) < count and attempts < count * 20:
        attempts += 1
        g = Gen(rng)
        prefix = ''
        icase = rng.random() < 0.12
        flag_choices = [x for x in ['i' if icase else '', 's' if rng.random() < 0.2 else '', 'm' if rng.random() < 0.2 else '', 'a' if (rng.random() < 0.1 and not icase) else ''] if x]
        if flag_choices:
            prefix = '(?' + ''.join(flag_choices) + ')'
        g.icase = icase
        try:
            src, node = g.alt(0)
        except RecursionError:
            continue
        pattern = prefix + src
        ctx = rng.choice([S, A])
        try:
            compiled = re.compile(pattern, re.S if ctx == S else 0)
        except (re.error, OverflowError, RecursionError):
            continue
        inputs = []
        for _ in range(20):
            caps = {}
            inputs.append(sample(node, rng, caps))
        for text in list(inputs[:20]):
            if len(inputs) < 40:
                inputs.append(mutate(text, rng))
        while len(inputs) < per:
            inputs.append(''.join(rng.choice(SAMPLE_POOL) for _ in range(rng.randint(0, 8))))
        inputs = inputs[:per]
        out.append((pattern, ctx, inputs))
    return out


# ---- evaluation ----------------------------------------------------------------------------------------------
def evaluate(pattern, ctx, text):
    flags = re.S if ctx == S else 0
    compiled = re.compile(pattern, flags)
    m = compiled.search(text) if ctx == S else compiled.match(text)
    if m is None:
        return None
    return {'span': [m.start(), m.end()], 'groups': list(m.groups()), 'groupdict': m.groupdict()}


def build_case(kind, pattern, ctx, inputs):
    seen, uniq = set(), []
    for text in inputs:
        if text not in seen:
            seen.add(text)
            uniq.append(text)
    return {'kind': kind, 'pattern': pattern, 'context': ctx, 'inputs': uniq, 'expected': [evaluate(pattern, ctx, t) for t in uniq]}


# ---- unicode sweep -------------------------------------------------------------------------------------------
def ranges_of(predicate):
    out, start = [], None
    for cp in range(MAX_CP):
        if 0xD800 <= cp <= 0xDFFF:
            ok = False
        else:
            ok = predicate(cp)
        if ok and start is None:
            start = cp
        elif not ok and start is not None:
            out.append([start, cp - 1])
            start = None
    if start is not None:
        out.append([start, MAX_CP - 1])
    return out


def class_sweep():
    out = []
    for pattern in [r'\w', r'\d', r'\s', r'\W', r'\D', r'\S', '.', r'(?s).', r'[^\w]', r'\b', r'(?i)\w', r'(?i)\W']:
        compiled = re.compile(pattern)
        out.append({'pattern': pattern, 'ranges': ranges_of(lambda cp, c=compiled: c.search(chr(cp)) is not None)})
    assigned = ranges_of(lambda cp: unicodedata.category(chr(cp)) != 'Cn')
    return out, assigned


# ---- rejects -------------------------------------------------------------------------------------------------
# (pattern, context, documented code). The test asserts that Node refuses each row with exactly this code.
REJECTS = [
    # flags
    ('(?x) a b', S, 'UNSUPPORTED_FLAG'), ('(?L)a', S, 'UNSUPPORTED_FLAG'), ('(?x:a b)', S, 'UNSUPPORTED_FLAG'), ('(?-x:a)', S, 'UNSUPPORTED_FLAG'),
    ('(?i-q:a)', S, 'UNSUPPORTED_FLAG'), ('(?-u:a)', S, 'UNSUPPORTED_FLAG'), ('(?-a:a)', S, 'UNSUPPORTED_FLAG'), ('(?ix)a', S, 'UNSUPPORTED_FLAG'),
    ('(?q)a', S, 'SYNTAX'), ('(?au)a', S, 'SYNTAX'), ('(?i-i:a)', S, 'SYNTAX'), ('a(?i)b', S, 'SYNTAX'), ('(?i)a|(?s)b', S, 'SYNTAX'),
    ('(?i', S, 'SYNTAX'), ('(?-)', S, 'SYNTAX'), ('(?i-)', S, 'SYNTAX'), ('(?a)(?u)a', S, 'SYNTAX'), ('(?i-s)a', S, 'SYNTAX'),
    ('(?ai)a', S, 'INEXACT_SEMANTICS'), ('(?a)(?i:a)', S, 'INEXACT_SEMANTICS'), ('(?i)(?a:a)', S, 'INEXACT_SEMANTICS'),
    # scoped ASCII/Unicode switches: CPython's re.search pre-filter compiles the leading class with the outer flags
    ('(?a:' + BS + 'S)x', S, 'INEXACT_SEMANTICS'), ('(?a:' + BS + 'D)', S, 'INEXACT_SEMANTICS'), ('(?a:' + BS + 'W)', S, 'INEXACT_SEMANTICS'),
    ('(?a:[^' + BS + 'd])', S, 'INEXACT_SEMANTICS'), ('(?a)(?u:' + BS + 'd)', S, 'INEXACT_SEMANTICS'), ('(?a)(?u:' + BS + 'w)', S, 'INEXACT_SEMANTICS'),
    ('(?a:(?u:' + BS + 'd))', S, 'INEXACT_SEMANTICS'), ('(?a:x' + BS + 'S)', S, 'INEXACT_SEMANTICS'),
    # unsupported constructs
    ('a*+', S, 'UNSUPPORTED_CONSTRUCT'), ('a++', S, 'UNSUPPORTED_CONSTRUCT'), ('a?+', S, 'UNSUPPORTED_CONSTRUCT'), ('a{1,2}+', S, 'UNSUPPORTED_CONSTRUCT'),
    ('(?>a)', S, 'UNSUPPORTED_CONSTRUCT'), ('(a)(?(1)b|c)', S, 'UNSUPPORTED_CONSTRUCT'), ('(?(1)b)', S, 'UNSUPPORTED_CONSTRUCT'),
    (BS + 'N{DASH}', S, 'UNSUPPORTED_CONSTRUCT'), ('[' + BS + 'N{DASH}]', S, 'UNSUPPORTED_CONSTRUCT'), (BS + 'z', S, 'UNSUPPORTED_CONSTRUCT'),
    ('[[:alpha:]]', S, 'UNSUPPORTED_CONSTRUCT'), ('[[.a.]]', S, 'UNSUPPORTED_CONSTRUCT'), ('[[=a=]]', S, 'UNSUPPORTED_CONSTRUCT'),
    ('[a--b]', S, 'UNSUPPORTED_CONSTRUCT'), ('[a&&b]', S, 'UNSUPPORTED_CONSTRUCT'), ('[a~~b]', S, 'UNSUPPORTED_CONSTRUCT'),
    ('[a||b]', S, 'UNSUPPORTED_CONSTRUCT'), ('[a-z--b]', S, 'UNSUPPORTED_CONSTRUCT'), ('[[a]', S, 'UNSUPPORTED_CONSTRUCT'),
    ('(?P<' + cps(0xE9) + '>a)', S, 'UNSUPPORTED_CONSTRUCT'),
    # syntax errors CPython reports
    ('(?<n>a)', S, 'SYNTAX'), (BS + 'q', S, 'SYNTAX'), (BS + 'e', S, 'SYNTAX'), ('[' + BS + 'q]', S, 'SYNTAX'), (BS + '8', S, 'SYNTAX'),
    (BS + '2(a)', S, 'SYNTAX'), ('(a' + BS + '1)', S, 'SYNTAX'), ('(?P<a>x)(?P<a>y)', S, 'SYNTAX'), ('(?P=zz)', S, 'SYNTAX'),
    ('(?P<1a>x)', S, 'SYNTAX'), ('(?P<a b>x)', S, 'SYNTAX'), ('(?P<>x)', S, 'SYNTAX'), ('(?P<a', S, 'SYNTAX'), ('(?P', S, 'SYNTAX'),
    ('(?Px)', S, 'SYNTAX'), ('(?', S, 'SYNTAX'), ('(a', S, 'SYNTAX'), ('a)', S, 'SYNTAX'), ('(?:a', S, 'SYNTAX'), ('[a', S, 'SYNTAX'), ('[]', S, 'SYNTAX'),
    ('a**', S, 'SYNTAX'), ('a*{2}', S, 'SYNTAX'), ('a{2}{3}', S, 'SYNTAX'), ('*a', S, 'SYNTAX'), ('+a', S, 'SYNTAX'), ('?a', S, 'SYNTAX'),
    ('{1}a', S, 'SYNTAX'), ('a|*', S, 'SYNTAX'), ('(*a)', S, 'SYNTAX'), ('a{3,2}', S, 'SYNTAX'), ('a{4294967295}', S, 'SYNTAX'),
    ('a{1,4294967295}', S, 'SYNTAX'), ('^*', S, 'SYNTAX'), (BS + 'b+', S, 'SYNTAX'),
    ('$+', S, 'SYNTAX'), (BS + 'A*', S, 'SYNTAX'), (BS + 'Z?', S, 'SYNTAX'), (BS, S, 'SYNTAX'), ('a' + BS, S, 'SYNTAX'),
    (BS + 'x4', S, 'SYNTAX'), (BS + 'u12', S, 'SYNTAX'), (BS + 'U00110000', S, 'SYNTAX'), (BS + 'U1234', S, 'SYNTAX'), (BS + '400', S, 'SYNTAX'),
    ('[b-a]', S, 'SYNTAX'), ('[' + BS + 'd-z]', S, 'SYNTAX'), ('[a-' + BS + 'd]', S, 'SYNTAX'), ('(?#abc', S, 'SYNTAX'), ('(?<=a+)b', S, 'SYNTAX'),
    ('(?<=a|bc)d', S, 'SYNTAX'), ('(?<=a*)b', S, 'SYNTAX'), ('(?<a)b', S, 'SYNTAX'), ('(?=a', S, 'SYNTAX'), (BS + 'N', S, 'UNSUPPORTED_CONSTRUCT'),
    # documented limits (UNSUPPORTED_CONSTRUCT) for valid Python: a quantifier on a lookaround, nesting beyond the parser limit
    ('(?=a)*', S, 'UNSUPPORTED_CONSTRUCT'), ('(?!a)+', S, 'UNSUPPORTED_CONSTRUCT'), ('(?<=a)*b', S, 'UNSUPPORTED_CONSTRUCT'),
    ('(?=a)*', A, 'UNSUPPORTED_CONSTRUCT'), ('(' * 400 + 'a' + ')' * 400, S, 'UNSUPPORTED_CONSTRUCT'),
    # emulation limits (INEXACT_SEMANTICS): CPython accepts these, the translation would not be exact
    ('(?:(a)|b)+', S, 'INEXACT_SEMANTICS'), ('(?:(a)|b)*', S, 'INEXACT_SEMANTICS'), ('(?:(a)?b)+', S, 'INEXACT_SEMANTICS'),
    ('(?:x|(y))+', S, 'INEXACT_SEMANTICS'), ('(?:x(a)?)*', S, 'INEXACT_SEMANTICS'), ('(?:(a)|b){1,2}', S, 'INEXACT_SEMANTICS'),
    ('(?:a*)*', S, 'INEXACT_SEMANTICS'), ('(?:|a)+', S, 'INEXACT_SEMANTICS'), ('(?:a|)*', S, 'INEXACT_SEMANTICS'), ('(a*)*', S, 'INEXACT_SEMANTICS'),
    ('(?:a?)?', S, 'INEXACT_SEMANTICS'), ('(?:a?)*b', S, 'INEXACT_SEMANTICS'), ('(?:^|,)+', S, 'INEXACT_SEMANTICS'), ('(?:\\b)*', S, 'INEXACT_SEMANTICS'), ('(?:(?=a))*', S, 'INEXACT_SEMANTICS'),
    ('(?:(a)|b)' + BS + '1', S, 'INEXACT_SEMANTICS'), ('(?:(a))?' + BS + '1', S, 'INEXACT_SEMANTICS'), ('(a)|' + BS + '1', S, 'INEXACT_SEMANTICS'),
    ('(?!(a))' + BS + '1', S, 'INEXACT_SEMANTICS'), ('(?i)(a)' + BS + '1', S, 'INEXACT_SEMANTICS'), ('(?<=(a))b', S, 'INEXACT_SEMANTICS'),
    ('(a)(?<=' + BS + '1)', S, 'INEXACT_SEMANTICS'), ('(?i)' + cps(0xE9), S, 'INEXACT_SEMANTICS'), ('(?i)[' + cps(0xE0) + '-' + cps(0xFF) + ']', S, 'INEXACT_SEMANTICS'),
    ('(?i)[a-' + cps(0xE9) + ']', S, 'INEXACT_SEMANTICS'), ('(?i)' + BS + 'xe9', S, 'INEXACT_SEMANTICS'), ('(?i)a' + cps(0x1F600), S, 'INEXACT_SEMANTICS'),
    ('(?i:' + cps(0x212A) + ')', S, 'INEXACT_SEMANTICS'), ('(?i)[' + cps(0x17F) + ']', S, 'INEXACT_SEMANTICS'),
    # the attempts context rejects the same things
    ('(?P<a>x)(?P<a>y)', A, 'SYNTAX'), ('(?:(a)|b)+', A, 'INEXACT_SEMANTICS'), ('a*+', A, 'UNSUPPORTED_CONSTRUCT'), (BS + 'z', A, 'UNSUPPORTED_CONSTRUCT'),
    ('(?x)a', A, 'UNSUPPORTED_FLAG'),
]


def reject_cases():
    out = []
    for pattern, ctx, code in REJECTS:
        py_error = None
        try:
            re.compile(pattern, re.S if ctx == S else 0)
        except (re.error, OverflowError, ValueError, RecursionError) as e:
            py_error = '%s: %s' % (type(e).__name__, e)
        out.append({'pattern': pattern, 'context': ctx, 'code': code, 'pythonError': py_error})
    return out


def write_lines(path, head, key, items):
    """One entry per line so that a diff points at the entry that changed. Pure ASCII (ensure_ascii)."""
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('{' + json.dumps(head, separators=(',', ':'))[1:-1] + ',\n')
        f.write(json.dumps(key) + ':[\n')
        for i, item in enumerate(items):
            f.write(json.dumps(item, separators=(',', ':')) + (',' if i < len(items) - 1 else '') + '\n')
        f.write(']\n}\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--out', default=os.path.dirname(os.path.abspath(__file__)), help='folder that receives the two JSON files')
    args = ap.parse_args()
    rng = random.Random(SEED)
    meta = {'python': '.'.join(str(p) for p in sys.version_info[:3]), 'unicode': unicodedata.unidata_version, 'seed': SEED}
    cases = []
    for pattern, ctx, extra in TABLE:
        cases.append(build_case('table', pattern, ctx, EDGE_INPUTS + extra))
    for pattern, ctx, inputs in v9_cases():
        cases.append(build_case('v9', pattern, ctx, inputs))
    for pattern, ctx, inputs in random_cases(rng):
        cases.append(build_case('random', pattern, ctx, inputs))
    sweep, assigned = class_sweep()
    os.makedirs(args.out, exist_ok=True)
    golden = os.path.join(args.out, 'regex-golden.json')
    with open(golden, 'w', encoding='utf-8', newline='\n') as f:
        f.write('{"meta":' + json.dumps(meta, separators=(',', ':')) + ',\n"assigned":' + json.dumps(assigned, separators=(',', ':')) + ',\n')
        f.write('"classes":[\n')
        for i, item in enumerate(sweep):
            f.write(json.dumps(item, separators=(',', ':')) + (',' if i < len(sweep) - 1 else '') + '\n')
        f.write('],\n"cases":[\n')
        for i, item in enumerate(cases):
            f.write(json.dumps(item, separators=(',', ':')) + (',' if i < len(cases) - 1 else '') + '\n')
        f.write(']\n}\n')
    rejects = reject_cases()
    write_lines(os.path.join(args.out, 'regex-rejects.json'), {'meta': meta}, 'rejects', rejects)
    kinds = {}
    for c in cases:
        kinds[c['kind']] = kinds.get(c['kind'], 0) + 1
    print('wrote', golden, kinds, 'results', sum(len(c['inputs']) for c in cases), 'rejects', len(rejects))


if __name__ == '__main__':
    main()
