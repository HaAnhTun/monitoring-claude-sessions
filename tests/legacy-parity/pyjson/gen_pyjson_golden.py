#!/usr/bin/env python3
"""Generator of the PyJson golden data (design 01 section 1.9, ADR 0003). Dev tool, run by hand or by the WP-05 gate.

    PYTHONDONTWRITEBYTECODE=1 python -B gen_pyjson_golden.py [--out DIR]

Writes exactly one file, `pyjson-golden.json`, into DIR (default: the folder of this script). The output is
deterministic (fixed seed, no timestamps), so regenerating into a scratch folder and diffing against the committed
file proves that the committed data still comes from Python. It uses only the standard library and writes no
bytecode. The test that consumes it is `runtime/tests/parity/pyjson.golden.test.ts`.
"""
import argparse
import json
import math
import os
import random
import struct
import sys
import unicodedata

SEED = 20261011
BS = chr(92)
OUT_NAME = 'pyjson-golden.json'


def dumps_compact(v):
    return json.dumps(v, ensure_ascii=False)


def short(v):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= 120 else s[:117] + '...'


# ---- numbers -----------------------------------------------------------------------------------------------
FIXED_LEXEMES = [
    '0', '-0', '1', '-1', '24', '24.0', '1.5', '1.50', '0.1', '0.5', '1e5', '1E5', '1e+5', '1e-5', '1.0e-4', '0.0001',
    '0.00001', '0.000123', '1e15', '1e16', '1.5e16', '9999999999999998', '9999999999999999.0', '12345678901234567.0',
    '123456789012345678', '9007199254740991', '9007199254740992', '9007199254740993', '-9007199254740993',
    '9007199254740993.0', '-1e-7', '1e21', '1e22', '1e23', '1e308', '1.7976931348623157e308', '5e-324', '2.5e-5',
    '2.5e-4', '100000000000000000000', '-100000000000000000000', '0.30000000000000004', '-0.0', '0.0', '0e0', '0E-5',
    '1.0', '10.0', '100.0', '1000000.0', '123456789.123456789', '1e0', '1.0E+2', '4.35', '0.1e1', '12e-1', '1e-4',
    '1e-5', '1e100', '1e-100', '1.5e300', '3.14159', '2.718281828459045', '65536', '4294967296', '18446744073709551616',
    '340282366920938463463374607431768211456', 'NaN', 'Infinity', '-Infinity', '1e999', '-1e999', '1e-999', '-1e-999',
    '0.1e-6', '123e-20', '1' + '0' * 30, '-' + '9' * 40, '1.' + '0' * 20, '0.' + '0' * 10 + '1',
]


def number_cases(rng):
    lex = list(FIXED_LEXEMES)
    for i in range(20000):
        x = struct.unpack('<d', struct.pack('<Q', rng.getrandbits(64)))[0]
        if math.isnan(x) or math.isinf(x):
            continue
        # Alternate the lexeme shape so that the parser sees more than the shortest repr.
        shape = i % 4
        if shape == 0:
            lex.append(repr(x))
        elif shape == 1:
            lex.append('%.17g' % x)
        elif shape == 2:
            lex.append('%.20e' % x)
        else:
            lex.append(('%.12g' % x))
    for _ in range(3000):
        lex.append(repr(rng.uniform(-1e6, 1e6)))
    for _ in range(3000):
        digits = rng.randint(1, 40)
        value = rng.randint(10 ** (digits - 1), 10 ** digits - 1) * rng.choice((1, -1))
        lex.append(str(value))
    return [[s, json.dumps(json.loads(s))] for s in lex]


# ---- strings -----------------------------------------------------------------------------------------------
SINGLE_CPS = list(range(0, 0x100)) + [
    0x2028, 0x2029, 0x7F, 0x80, 0x9F, 0xA0, 0xAD, 0x100, 0x17F, 0x212A, 0x3000, 0xD7FF, 0xE000, 0xFEFF, 0xFFFD, 0xFFFE,
    0xFFFF, 0x10000, 0x1D11E, 0x1F600, 0xE0001, 0x10FFFF,
]
MULTI = [
    '', 'plain', 'with space', 'tab' + chr(9) + 'cr' + chr(13) + 'lf' + chr(10), 'quote"inside', 'back' + BS + 'slash',
    BS + BS, BS + 'n', '"' + BS, 'caf' + chr(0xE9) + ' ' + chr(0x1F600) + ' ' + chr(0x1D11E), 'a' + chr(0x2028) + 'b',
    'x' * 130, chr(0x1F600) * 70, 'it' + "'" + 's', 'say "hi" it' + "'" + 's', chr(0) + chr(31) + chr(32), '/slash/',
    chr(0xA0) + chr(0x3000) + chr(0xAD),
]


def string_cases():
    out = []
    for text in [chr(cp) for cp in SINGLE_CPS] + MULTI:
        out.append({
            'cps': [ord(c) for c in text],
            'raw': json.dumps(text, ensure_ascii=False),
            'ascii': json.dumps(text),
            'repr': repr(text),
            'cn': any(unicodedata.category(c) == 'Cn' for c in text),
        })
    return out


def repr_sweep():
    cps = list(range(0, 0x800)) + list(range(0x800, 0x110000, 97)) + list(range(0xE0000, 0xE0100)) + list(range(0xFE00, 0xFE10))
    out = []
    for cp in cps:
        if 0xD800 <= cp <= 0xDFFF:
            continue
        c = chr(cp)
        out.append([cp, repr(c), 1 if unicodedata.category(c) == 'Cn' else 0])
    return out


# ---- documents ---------------------------------------------------------------------------------------------
HAND_DOCS = [
    'null', 'true', 'false', '0', '-0', '1.0', '"s"', '[]', '{}', '[ ]', '{ }', ' [1 , 2 ,3] ',
    '{"b":1,"2":2,"a":3}', '{"b":1,"a":2,"b":3}', '{"a":{"b":{"c":[]}}}', '[[],[[]],{}]', '{"a":[1,2.0,"x",null,true]}',
    '{"10":1,"9":2,"1":3,"b":4,"0":5}', '{"k":"caf' + chr(0xE9) + '","k2":"' + BS + 'u00e9' + BS + 'ud83d' + BS + 'ude00"}',
    '{"' + chr(0xE9) + '":1}', '[1e5,1E5,1.0,100.0,1e-7,123456789012345678901234567890]', '[NaN,Infinity,-Infinity]',
    '{"a": 24.0, "b": 24, "c": 1e16, "d": 1e15}', '"' + BS + 'u0000' + BS + 'u001f' + BS + 'u007f"', '"' + BS + '/' + BS + 'b' + BS + 'f"',
    '{"config":{"schema_version":1,"window_hours":24,"limits":{"event_window_mb":4.5}},"list":[{"x":1},{"y":[true,false]}]}',
    '[{"a":1},{"a":2}]', '{"":""}', '{"a":[]  ,"b":{}  }', '[1,[2,[3,[4,[5]]]]]', chr(10) + '[1]' + chr(10),
    '{"deep":{"deeper":{"deepest":{"x":[1,2,{"y":null}]}}}}', '"' + chr(0x2028) + chr(0x2029) + '"',
    '"' + chr(0x1F600) + '"', '[0.1,0.2,0.30000000000000004]', '{"a":-0.0,"b":-0}',
]
KEY_POOL = ['a', 'b', 'name', 'match', 'label', 'x', '1', '2', '10', '9', 'k' + chr(0xE9), chr(0x1F600), 'q"uote', 'sp ace', 'Z']
STR_POOL = ['', 'x', 'hello world', 'caf' + chr(0xE9), chr(0x1F600) + 'e', 'quote"s', BS + 'path', 'line' + chr(10) + 'two',
            'tab' + chr(9), chr(0x2028), 'k' * 30, '{1}', 'it' + "'" + 's']
NUM_POOL = ['0', '-0', '1', '-7', '24', '24.0', '1.5', '0.1', '1e5', '1E-5', '2.5e+3', '123456789012345678901', '1e16', '-0.0', '3.0e0']


def ws(rng):
    return rng.choice(['', '', ' ', '  ', chr(10), chr(9), ' ' + chr(10) + ' '])


def rand_text(rng, depth):
    kind = rng.random()
    if depth >= 4 or kind < 0.35:
        c = rng.random()
        if c < 0.4:
            return rng.choice(NUM_POOL)
        if c < 0.75:
            return json.dumps(rng.choice(STR_POOL), ensure_ascii=rng.random() < 0.5)
        return rng.choice(['null', 'true', 'false'])
    if kind < 0.65:
        n = rng.randint(0, 4)
        return '[' + ws(rng) + (',' + ws(rng)).join(rand_text(rng, depth + 1) for _ in range(n)) + ws(rng) + ']'
    n = rng.randint(0, 4)
    items = []
    for _ in range(n):
        items.append(json.dumps(rng.choice(KEY_POOL), ensure_ascii=rng.random() < 0.5) + ws(rng) + ':' + ws(rng) + rand_text(rng, depth + 1))
    return '{' + ws(rng) + (',' + ws(rng)).join(items) + ws(rng) + '}'


def document_cases(rng):
    texts = list(HAND_DOCS)
    for _ in range(400):
        texts.append(ws(rng) + rand_text(rng, 0) + ws(rng))
    out = []
    for text in texts:
        v = json.loads(text)
        out.append({
            'text': text,
            'indent': json.dumps(v, indent=2, ensure_ascii=False),
            'compact': json.dumps(v, ensure_ascii=False),
            'ascii': json.dumps(v),
            'ascii60': json.dumps(v)[:60],
            'short': short(v),
        })
    return out


def short_cases():
    texts = []
    for n in (0, 1, 50, 100, 110, 112, 114, 115, 116, 117, 118, 119, 120, 121, 122, 130):
        texts.append(json.dumps('x' * max(0, n - 2)))
        texts.append(json.dumps(chr(0x1F600) * max(0, n - 2), ensure_ascii=False))
        texts.append(json.dumps(chr(0xE9) * max(0, n - 2), ensure_ascii=False))
    texts.append(json.dumps({'a': ['b' * 40, 'c' * 40, 'd' * 40]}))
    out = []
    for text in texts:
        v = json.loads(text)
        out.append([text, short(v)])
    return out


# ---- equality ----------------------------------------------------------------------------------------------
EQUAL_PAIRS = [
    ('1', '1.0'), ('1', 'true'), ('0', 'false'), ('0', '-0.0'), ('0.0', '-0.0'), ('1.5', '1.50'), ('[1]', '[true]'),
    ('[1,2]', '[2,1]'), ('{"a":1,"b":2}', '{"b":2,"a":1}'), ('{"a":1}', '{"a":1,"b":2}'), ('{"a":1}', '{"a":true}'),
    ('{"a":[1,{"b":2}]}', '{"a":[1.0,{"b":2.0}]}'), ('"a"', '"a"'), ('"a"', '"b"'), ('"1"', '1'), ('null', 'null'),
    ('null', '0'), ('null', 'false'), ('[]', '{}'), ('[]', '[]'), ('{}', '{}'), ('[null]', '[0]'), ('2', '2.5'),
    ('100000000000000000000', '1e20'), ('9007199254740993', '9007199254740992.0'), ('9007199254740993', '9007199254740993'),
    ('9007199254740992', '9007199254740992.0'), ('1e999', 'Infinity'), ('Infinity', '-Infinity'), ('1e400', '123'),
    ('{"a":null}', '{"a":null}'), ('[[1],[2]]', '[[1],[2]]'), ('[[1],[2]]', '[[1],[3]]'), ('"' + chr(0xE9) + '"', '"' + chr(0xE9) + '"'),
    ('"' + chr(0x1F600) + '"', '"' + chr(0x1F600) + '"'),
]


def equal_cases():
    return [[a, b, json.loads(a) == json.loads(b)] for a, b in EQUAL_PAIRS]


# ---- errors ------------------------------------------------------------------------------------------------
BAD_TEXTS = [
    '', ' ', '   ' + chr(10), 'nul', 'tru', 'fals', 'NaN1', 'Inf', '-', '-x', '+1', '.5', '1.', '1.e5', '01', '00', '-01',
    '1e', '1e+', '[1,]', '[,1]', '[1 2]', '[1', '[', ']', '{', '}', '{"a"', '{"a":', '{"a":1', '{"a":1,}', '{"a":1,',
    '{,}', '{"a" 1}', '{a:1}', "{'a':1}", '{"a":1 "b":2}', '{"a":1}}', '[1]]', '1 2', 'true false', '"abc', '"abc' + chr(10) + '"',
    '"a' + chr(9) + 'b"', '"' + BS + 'x"', '"' + BS + 'u12"', '"' + BS + 'u12G4"', '"' + BS, '"abc' + BS, "'abc'",
    chr(0xFEFF) + '{}', chr(0xFEFF) + '1', '{"a":1}' + chr(10) + chr(10) + 'x', '[1,' + chr(10) + '  2,' + chr(10) + '  ]',
    '{' + chr(10) + '  "a": 1,' + chr(10) + '  "b": ' + chr(10) + '}', '[' + chr(0x1F600) + ']', '"' + chr(0x1F600) + '" x',
    '// comment' + chr(10) + '1', '/* c */ 1', '{"a":1,"b":2,"c":3,,}', '[[[[', '{"a":{"b":{"c":',
]
LONE_SURROGATES = [
    '"' + BS + 'ud800"', '"' + BS + 'udc00"', '"' + BS + 'ud800' + BS + 'u0041"', '"' + BS + 'udbff' + BS + 'udbff"',
    '"' + BS + 'udc00' + BS + 'ud800"', '{"k' + BS + 'ud83d":1}',
]


def error_cases():
    out = []
    for text in BAD_TEXTS:
        try:
            json.loads(text)
        except json.JSONDecodeError as e:
            out.append([text, e.msg, e.lineno, e.colno, e.pos])
        else:
            raise SystemExit('expected an error for %r' % (text,))
    return out


def lone_surrogate_cases():
    # Python accepts these; the Node reader refuses them on purpose (01 section 1.9).
    out = []
    for text in LONE_SURROGATES:
        json.loads(text)
        out.append(text)
    return out


def write_golden(path, data):
    """One case per line so that a diff points at the case that changed. Pure ASCII (ensure_ascii)."""
    lines = ['{']
    keys = list(data.keys())
    for ki, key in enumerate(keys):
        value = data[key]
        tail = ',' if ki < len(keys) - 1 else ''
        if isinstance(value, list):
            lines.append(json.dumps(key) + ':[')
            for i, item in enumerate(value):
                lines.append(json.dumps(item, separators=(',', ':')) + (',' if i < len(value) - 1 else ''))
            lines.append(']' + tail)
        else:
            lines.append(json.dumps(key) + ':' + json.dumps(value, separators=(',', ':')) + tail)
    lines.append('}')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--out', default=os.path.dirname(os.path.abspath(__file__)), help='folder that receives ' + OUT_NAME)
    args = ap.parse_args()
    rng = random.Random(SEED)
    data = {
        'meta': {'python': '.'.join(str(p) for p in sys.version_info[:3]), 'unicode': unicodedata.unidata_version, 'seed': SEED},
        'numbers': number_cases(rng),
        'strings': string_cases(),
        'reprSweep': repr_sweep(),
        'documents': document_cases(rng),
        'short': short_cases(),
        'equals': equal_cases(),
        'errors': error_cases(),
        'loneSurrogates': lone_surrogate_cases(),
    }
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, OUT_NAME)
    write_golden(path, data)
    print('wrote', path, {k: (len(v) if isinstance(v, list) else v) for k, v in data.items()})


if __name__ == '__main__':
    main()
